"""
Conversation memory management via community-docs Lucie API.

Uses the /lucie/* endpoints for conversation management with L1 summaries.
"""

import httpx
from typing import Optional


async def get_or_create_conversation(
    client: httpx.AsyncClient,
    visitor_id: str
) -> str:
    """Get or create a conversation for a visitor."""
    response = await client.post(
        "/lucie/conversation",
        json={"visitorId": visitor_id}
    )
    response.raise_for_status()
    data = response.json()

    if not data.get("success"):
        raise Exception(data.get("error", "Failed to get/create conversation"))

    return data.get("conversationId")


async def add_message(
    client: httpx.AsyncClient,
    visitor_id: str,
    role: str,
    content: str
) -> str:
    """Add a message to a conversation."""
    response = await client.post(
        "/lucie/message",
        json={
            "visitorId": visitor_id,
            "role": role,
            "content": content
        }
    )
    response.raise_for_status()
    data = response.json()

    if not data.get("success"):
        raise Exception(data.get("error", "Failed to add message"))

    return data.get("messageId")


async def get_conversation_context(
    client: httpx.AsyncClient,
    visitor_id: str
) -> str:
    """Get conversation context (summaries + recent messages) as formatted string."""
    response = await client.get(f"/lucie/context/{visitor_id}")
    response.raise_for_status()
    data = response.json()

    if not data.get("success"):
        return ""

    return data.get("context", "")


async def get_messages(
    client: httpx.AsyncClient,
    visitor_id: str,
    limit: int = 50
) -> list[dict]:
    """Get message history from a conversation."""
    response = await client.get(
        f"/lucie/history/{visitor_id}",
        params={"limit": str(limit)}
    )
    response.raise_for_status()
    data = response.json()

    if not data.get("success"):
        return []

    return data.get("messages", [])


async def force_summarize(
    client: httpx.AsyncClient,
    visitor_id: str
) -> Optional[dict]:
    """Force creation of L1 summary."""
    response = await client.post(f"/lucie/summarize/{visitor_id}")
    response.raise_for_status()
    data = response.json()

    if not data.get("success"):
        return None

    return data.get("summary")


async def add_tool_summary(
    client: httpx.AsyncClient,
    visitor_id: str,
    user_question: str,
    tools_used: list[str],
    key_findings: str,
    assistant_action: str
) -> Optional[str]:
    """Add a tool call summary to the conversation."""
    response = await client.post(
        "/lucie/tool-summary",
        json={
            "visitorId": visitor_id,
            "userQuestion": user_question,
            "toolsUsed": tools_used,
            "keyFindings": key_findings,
            "assistantAction": assistant_action
        }
    )
    response.raise_for_status()
    data = response.json()

    if not data.get("success"):
        return None

    return data.get("summaryId")


async def get_tool_summaries(
    client: httpx.AsyncClient,
    visitor_id: str
) -> list[dict]:
    """Get tool call summaries for a conversation."""
    response = await client.get(f"/lucie/tool-summaries/{visitor_id}")
    response.raise_for_status()
    data = response.json()

    if not data.get("success"):
        return []

    return data.get("toolSummaries", [])
