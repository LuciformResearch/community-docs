"""
FastAPI server for Lucie Agent.

Exposes the LangGraph agent via HTTP endpoints with SSE streaming support.
Uses visitor-based conversations (no auth required).
"""

import json
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional
from collections import defaultdict

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .config import settings
from .agent import run_agent, run_agent_streaming
from .memory import (
    get_or_create_conversation,
    add_message,
    get_conversation_context,
    get_messages,
)
from .tools import cleanup as cleanup_tools


# Rate limiting storage
rate_limit_ip_minute: dict[str, list[float]] = defaultdict(list)  # Anti-spam
rate_limit_ip_daily: dict[str, list[float]] = defaultdict(list)  # Daily quota par IP
rate_limit_visitor_daily: dict[str, list[float]] = defaultdict(list)  # Daily quota par visitor

# Whitelisted IPs (no rate limit for local debugging)
WHITELISTED_IPS = {"127.0.0.1", "localhost", "::1"}

# Limits
DAILY_LIMIT = 15  # Max messages per day (par IP ET par visitor)
IP_MINUTE_LIMIT = 5  # Anti-spam: max requests per IP per minute


def check_rate_limit(client_ip: str, visitor_id: str | None = None) -> tuple[bool, str]:
    """
    Check if client is within rate limit.

    Returns (allowed, reason) tuple.
    - Localhost is whitelisted for debugging
    - Per IP: 5/min (anti-spam) + 15/day (quota)
    - Per visitor: 15/day (quota)
    """
    # Whitelist localhost for debugging
    if client_ip in WHITELISTED_IPS:
        return True, "whitelisted"

    now = time.time()
    one_minute = 60
    one_day = 86400

    # Anti-spam: Check IP rate limit (per minute)
    rate_limit_ip_minute[client_ip] = [
        t for t in rate_limit_ip_minute[client_ip]
        if now - t < one_minute
    ]
    if len(rate_limit_ip_minute[client_ip]) >= IP_MINUTE_LIMIT:
        return False, f"Trop de requêtes, attendez un moment ({IP_MINUTE_LIMIT}/min)"

    # Daily quota per IP (prevents localStorage clear abuse)
    rate_limit_ip_daily[client_ip] = [
        t for t in rate_limit_ip_daily[client_ip]
        if now - t < one_day
    ]
    if len(rate_limit_ip_daily[client_ip]) >= DAILY_LIMIT:
        return False, f"Limite quotidienne atteinte ({DAILY_LIMIT} messages/jour). Revenez demain !"

    # Daily quota per visitor (for user feedback)
    if visitor_id:
        rate_limit_visitor_daily[visitor_id] = [
            t for t in rate_limit_visitor_daily[visitor_id]
            if now - t < one_day
        ]
        if len(rate_limit_visitor_daily[visitor_id]) >= DAILY_LIMIT:
            return False, f"Limite quotidienne atteinte ({DAILY_LIMIT} messages/jour). Revenez demain !"
        rate_limit_visitor_daily[visitor_id].append(now)

    # Record the request
    rate_limit_ip_minute[client_ip].append(now)
    rate_limit_ip_daily[client_ip].append(now)
    return True, "ok"


# HTTP client for community-docs API
http_client: Optional[httpx.AsyncClient] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    global http_client

    # Startup
    print(f"[Lucie Agent] Starting server on {settings.host}:{settings.port}")
    print(f"[Lucie Agent] Community Docs API: {settings.community_docs_api}")
    print(f"[Lucie Agent] Model: {settings.model_name}")

    http_client = httpx.AsyncClient(
        base_url=settings.community_docs_api,
        timeout=30.0
    )

    # Check community-docs API health
    try:
        response = await http_client.get("/health")
        if response.status_code == 200:
            print("[Lucie Agent] Community Docs API is healthy")
        else:
            print(f"[Lucie Agent] Warning: Community Docs API returned {response.status_code}")
    except Exception as e:
        print(f"[Lucie Agent] Warning: Could not connect to Community Docs API: {e}")

    yield

    # Shutdown
    print("[Lucie Agent] Shutting down...")
    await cleanup_tools()
    if http_client:
        await http_client.aclose()


# Create FastAPI app
app = FastAPI(
    title="Lucie Agent",
    description="LangGraph-based conversational agent representing Lucie Defraiteur",
    version="0.2.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request/Response models
class ChatRequest(BaseModel):
    """Chat request body."""
    message: str
    visitor_id: str  # Unique visitor identifier (from localStorage)
    stream: bool = True


class ChatResponse(BaseModel):
    """Non-streaming chat response."""
    success: bool
    visitor_id: str
    conversation_id: str
    response: str
    error: Optional[str] = None


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    timestamp: str
    model: str
    community_docs_api: str


# Endpoints
@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    return HealthResponse(
        status="ok",
        timestamp=datetime.utcnow().isoformat(),
        model=settings.model_name,
        community_docs_api=settings.community_docs_api,
    )


@app.post("/chat")
async def chat(request: Request, body: ChatRequest):
    """
    Chat with Lucie agent.

    Supports both streaming (SSE) and non-streaming responses.
    Uses visitor_id for conversation persistence.
    """
    # Get client IP for rate limiting (check CF-Connecting-IP header for real IP behind Cloudflare)
    client_ip = request.headers.get("CF-Connecting-IP") or (request.client.host if request.client else "unknown")

    allowed, reason = check_rate_limit(client_ip, body.visitor_id)
    if not allowed:
        print(f"[Lucie Agent] Rate limited: {client_ip} / {body.visitor_id} - {reason}")
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded: {reason}"
        )

    if not http_client:
        raise HTTPException(status_code=503, detail="Service not initialized")

    visitor_id = body.visitor_id

    try:
        # Get or create conversation for this visitor
        conversation_id = await get_or_create_conversation(http_client, visitor_id)
        print(f"[Lucie Agent] Conversation: {conversation_id} (visitor: {visitor_id})")

        # Get conversation context (summaries + recent messages)
        context = await get_conversation_context(http_client, visitor_id)

        # Store user message
        await add_message(http_client, visitor_id, "user", body.message)
        print(f"[Lucie Agent] [{visitor_id}] User: {body.message[:100]}...")

    except Exception as e:
        print(f"[Lucie Agent] Memory error: {e}")
        # Continue without memory if it fails
        conversation_id = f"lucie-{visitor_id}"
        context = ""

    if body.stream:
        # Streaming response via SSE
        return StreamingResponse(
            stream_response(body.message, visitor_id, conversation_id, context),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            }
        )
    else:
        # Non-streaming response
        try:
            response = await run_agent(body.message, conversation_id, context)

            # Store assistant message
            try:
                await add_message(http_client, visitor_id, "assistant", response)
            except Exception as e:
                print(f"[Lucie Agent] Failed to store response: {e}")

            print(f"[Lucie Agent] [{visitor_id}] Assistant: {response[:100]}...")

            return ChatResponse(
                success=True,
                visitor_id=visitor_id,
                conversation_id=conversation_id,
                response=response,
            )
        except Exception as e:
            print(f"[Lucie Agent] Error: {e}")
            return ChatResponse(
                success=False,
                visitor_id=visitor_id,
                conversation_id=conversation_id,
                response="",
                error=str(e),
            )


async def stream_response(message: str, visitor_id: str, conversation_id: str, context: str):
    """Generate SSE stream for chat response."""
    full_response = ""

    # Send start event with conversation ID
    yield f"event: start\ndata: {json.dumps({'conversationId': conversation_id, 'visitorId': visitor_id})}\n\n"

    try:
        async for event in run_agent_streaming(message, conversation_id, context):
            event_type = event.get("type")

            if event_type == "token":
                content = event.get("content", "")
                full_response += content
                yield f"event: token\ndata: {json.dumps({'content': content})}\n\n"

            elif event_type == "tool_start":
                tool_name = event.get("name", "unknown")
                yield f"event: tool_start\ndata: {json.dumps({'name': tool_name})}\n\n"

            elif event_type == "tool_end":
                tool_name = event.get("name", "unknown")
                # Don't send full output to client (too large), just notify
                yield f"event: tool_end\ndata: {json.dumps({'name': tool_name})}\n\n"

            elif event_type == "error":
                error = event.get("content", "Unknown error")
                yield f"event: error\ndata: {json.dumps({'error': error})}\n\n"

        # Store assistant message
        if full_response and http_client:
            try:
                await add_message(http_client, visitor_id, "assistant", full_response)
            except Exception as e:
                print(f"[Lucie Agent] Failed to store response: {e}")
            print(f"[Lucie Agent] [{visitor_id}] Assistant: {full_response[:100]}...")

        # Send done event
        yield f"event: done\ndata: {json.dumps({'conversationId': conversation_id})}\n\n"

    except Exception as e:
        print(f"[Lucie Agent] Stream error: {e}")
        yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"


@app.get("/history/{visitor_id}")
async def get_history(visitor_id: str, limit: int = 50):
    """Get message history for a visitor."""
    if not http_client:
        raise HTTPException(status_code=503, detail="Service not initialized")

    messages = await get_messages(http_client, visitor_id, limit)

    return {
        "success": True,
        "visitor_id": visitor_id,
        "messages": messages,
    }


# Run with: python -m uvicorn lucie_agent.main:app --host 0.0.0.0 --port 8000
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "lucie_agent.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )
