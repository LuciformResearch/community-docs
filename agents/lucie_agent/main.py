"""
FastAPI server for Lucie Agent.

Exposes the LangGraph agent via HTTP endpoints with SSE streaming support.
Uses visitor-based conversations (no auth required).
"""

import json
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
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
    add_tool_summary,
)
from .tools import cleanup as cleanup_tools


# Conversation log file
CONVERSATION_LOG = Path(__file__).parent / "conversation.log"


def _log_write(message: str):
    """Write to conversation log with flush for real-time."""
    with open(CONVERSATION_LOG, "a", encoding="utf-8") as f:
        f.write(message)
        f.flush()


def log_conversation_start(visitor_id: str, conversation_id: str, mode: str, user_message: str):
    """Log the start of a conversation turn (real-time)."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    _log_write(f"\n{'='*80}\n")
    _log_write(f"[{timestamp}] CONVERSATION - {mode.upper()}\n")
    _log_write(f"{'='*80}\n")
    _log_write(f"Visitor: {visitor_id}\n")
    _log_write(f"Conversation: {conversation_id}\n")
    _log_write(f"{'-'*80}\n")
    _log_write(f"USER MESSAGE:\n{user_message}\n")
    _log_write(f"{'-'*80}\n")
    _log_write(f"AGENT RESPONSE:\n")


def log_token(token: str):
    """Log a single token (real-time streaming)."""
    _log_write(token)


def log_tool_call(tool_name: str, event: str):
    """Log a tool call event (start/end)."""
    timestamp = datetime.now().strftime("%H:%M:%S")
    _log_write(f"\n[{timestamp}] 🔧 TOOL {event.upper()}: {tool_name}\n")


def log_conversation_end():
    """Log the end of a conversation turn."""
    _log_write(f"\n{'='*80}\n\n")


def log_conversation(
    visitor_id: str,
    conversation_id: str,
    mode: str,
    user_message: str,
    full_response: str,
    reasoning_steps: list[str] | None = None,
    tool_calls: list[dict] | None = None,
):
    """Log complete conversation turn to file (for non-streaming mode)."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

    with open(CONVERSATION_LOG, "a", encoding="utf-8") as f:
        f.write(f"\n{'='*80}\n")
        f.write(f"[{timestamp}] CONVERSATION - {mode.upper()}\n")
        f.write(f"{'='*80}\n")
        f.write(f"Visitor: {visitor_id}\n")
        f.write(f"Conversation: {conversation_id}\n")
        f.write(f"{'-'*80}\n")
        f.write(f"USER MESSAGE:\n{user_message}\n")
        f.write(f"{'-'*80}\n")

        if tool_calls:
            f.write(f"TOOL CALLS ({len(tool_calls)}):\n")
            for tc in tool_calls:
                f.write(f"  - {tc.get('name', 'unknown')}\n")
            f.write(f"{'-'*80}\n")

        f.write(f"RESPONSE:\n{full_response}\n")
        f.write(f"{'='*80}\n\n")


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

# Register Twilio WhatsApp webhook routes
try:
    from .twilio_webhook import register_twilio_routes
    register_twilio_routes(app)
    print("[Lucie Agent] Twilio WhatsApp webhook routes registered")
except ImportError as e:
    print(f"[Lucie Agent] Twilio webhook not available: {e}")


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
            result = await run_agent(body.message, conversation_id, context)
            response = result["response"]
            tool_summary = result.get("tool_summary")
            tool_calls = result.get("tool_calls", [])

            # Store assistant message with tool calls
            try:
                stored_tool_calls = tool_calls if tool_calls else None
                await add_message(http_client, visitor_id, "assistant", response, stored_tool_calls)
                if stored_tool_calls:
                    print(f"[Lucie Agent] [{visitor_id}] Stored {len(stored_tool_calls)} tool call(s)")
            except Exception as e:
                print(f"[Lucie Agent] Failed to store response: {e}")

            # Store tool summary if generated
            if tool_summary:
                try:
                    await add_tool_summary(
                        http_client,
                        visitor_id,
                        tool_summary.get("user_question", ""),
                        tool_summary.get("tools_used", []),
                        tool_summary.get("key_findings", ""),
                        tool_summary.get("assistant_action", "")
                    )
                    print(f"[Lucie Agent] [{visitor_id}] Tool summary stored (non-streaming)")
                except Exception as e:
                    print(f"[Lucie Agent] Failed to store tool summary: {e}")

            print(f"[Lucie Agent] [{visitor_id}] Assistant: {response[:100]}...")

            # Log complete conversation
            log_conversation(
                visitor_id=visitor_id,
                conversation_id=conversation_id,
                mode="non-streaming",
                user_message=body.message,
                full_response=response,
                tool_calls=tool_calls if tool_calls else None,
            )

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
    """Generate SSE stream for chat response with real-time logging."""
    full_response = ""
    tool_calls = []  # Collect tool calls for storage
    current_tool = None  # Track current tool being called

    # Send start event with conversation ID
    yield f"event: start\ndata: {json.dumps({'conversationId': conversation_id, 'visitorId': visitor_id})}\n\n"

    # Start real-time logging
    log_conversation_start(visitor_id, conversation_id, "streaming", message)

    try:
        async for event in run_agent_streaming(message, conversation_id, context):
            event_type = event.get("type")

            if event_type == "token":
                content = event.get("content", "")
                full_response += content
                log_token(content)  # Real-time token logging
                yield f"event: token\ndata: {json.dumps({'content': content})}\n\n"

            elif event_type == "tool_start":
                tool_name = event.get("name", "unknown")
                tool_args = event.get("args", {})
                current_tool = {"name": tool_name, "args": tool_args}
                log_tool_call(tool_name, "start")  # Real-time tool logging
                yield f"event: tool_start\ndata: {json.dumps({'name': tool_name, 'args': tool_args})}\n\n"

            elif event_type == "tool_end":
                tool_name = event.get("name", "unknown")
                tool_output = event.get("output", "")

                # Store tool call for later
                tool_calls.append({
                    "name": tool_name,
                    "args": current_tool.get("args", {}) if current_tool else {},
                    "result": tool_output,
                })
                current_tool = None

                log_tool_call(tool_name, "end")  # Real-time tool logging
                # Send full output to frontend
                yield f"event: tool_end\ndata: {json.dumps({'name': tool_name, 'output': tool_output})}\n\n"

            elif event_type == "tool_summary":
                # Store tool summary via API
                try:
                    await add_tool_summary(
                        http_client,
                        visitor_id,
                        event.get("user_question", ""),
                        event.get("tools_used", []),
                        event.get("key_findings", ""),
                        event.get("assistant_action", "")
                    )
                    print(f"[Lucie Agent] [{visitor_id}] Tool summary stored")
                except Exception as e:
                    print(f"[Lucie Agent] Failed to store tool summary: {e}")

            elif event_type == "rate_limit":
                # Rate limit retry notification
                attempt = event.get("attempt", 1)
                max_attempts = event.get("max_attempts", 5)
                delay_seconds = event.get("delay_seconds", 60)
                will_fallback = event.get("will_fallback", False)
                fallback_model = event.get("fallback_model", "")

                # Log to conversation log
                if will_fallback:
                    _log_write(f"\n[RATE LIMIT] Switching to fallback model: {fallback_model}\n")
                else:
                    _log_write(f"\n[RATE LIMIT] Retry {attempt}/{max_attempts} in {delay_seconds}s...\n")

                yield f"event: rate_limit\ndata: {json.dumps({'attempt': attempt, 'maxAttempts': max_attempts, 'delaySeconds': delay_seconds, 'willFallback': will_fallback, 'fallbackModel': fallback_model})}\n\n"

            elif event_type == "model_fallback":
                # Model fallback notification
                model = event.get("model", "unknown")
                _log_write(f"\n[FALLBACK] Now using model: {model}\n")
                yield f"event: model_fallback\ndata: {json.dumps({'model': model})}\n\n"

            elif event_type == "error":
                error = event.get("content", "Unknown error")
                yield f"event: error\ndata: {json.dumps({'error': error})}\n\n"

        # Store assistant message with tool calls
        if full_response and http_client:
            try:
                # Format tool calls for storage (only name, args, result)
                stored_tool_calls = [
                    {
                        "name": tc["name"],
                        "args": tc.get("args", {}),
                        "result": tc.get("result", ""),
                    }
                    for tc in tool_calls
                ] if tool_calls else None

                await add_message(http_client, visitor_id, "assistant", full_response, stored_tool_calls)
                if stored_tool_calls:
                    print(f"[Lucie Agent] [{visitor_id}] Stored {len(stored_tool_calls)} tool call(s)")
            except Exception as e:
                print(f"[Lucie Agent] Failed to store response: {e}")
            print(f"[Lucie Agent] [{visitor_id}] Assistant: {full_response[:100]}...")

        # End real-time logging
        log_conversation_end()

        # Send done event
        yield f"event: done\ndata: {json.dumps({'conversationId': conversation_id})}\n\n"

    except Exception as e:
        print(f"[Lucie Agent] Stream error: {e}")
        log_conversation_end()
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
