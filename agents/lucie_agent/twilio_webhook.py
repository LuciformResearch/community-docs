"""
Twilio WhatsApp Webhook for Lucie Agent.

Uses Twilio Sandbox for WhatsApp (free for demos).
Users must first send "join <sandbox-code>" to the Twilio number.
"""

import asyncio
import logging
import time
from fastapi import Form, Response
from twilio.rest import Client
from twilio.twiml.messaging_response import MessagingResponse

from .config import settings
from .agent import run_agent_streaming

logger = logging.getLogger(__name__)

# Twilio client (initialized lazily)
_twilio_client: Client | None = None

# Twilio Sandbox limit
MAX_MESSAGE_LENGTH = 1500
# Send progress update every N seconds during processing
PROGRESS_UPDATE_INTERVAL = 20


def get_twilio_client() -> Client:
    """Get or create Twilio client."""
    global _twilio_client
    if _twilio_client is None:
        if not settings.twilio_account_sid or not settings.twilio_auth_token:
            raise ValueError(
                "Twilio credentials not configured. "
                "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env"
            )
        _twilio_client = Client(
            settings.twilio_account_sid,
            settings.twilio_auth_token
        )
    return _twilio_client


def normalize_phone_number(phone: str) -> str:
    """
    Normalize WhatsApp phone number to use as visitor_id.
    Twilio sends: whatsapp:+33612345678
    We extract: +33612345678
    """
    if phone.startswith("whatsapp:"):
        return phone[9:]  # Remove "whatsapp:" prefix
    return phone


def split_message(message: str, max_length: int = MAX_MESSAGE_LENGTH) -> list[str]:
    """
    Split a long message into multiple chunks.
    Tries to split at paragraph or sentence boundaries.
    """
    if len(message) <= max_length:
        return [message]

    chunks = []
    remaining = message

    while remaining:
        if len(remaining) <= max_length:
            chunks.append(remaining)
            break

        # Try to find a good split point
        chunk = remaining[:max_length]

        # Try paragraph break first
        split_point = chunk.rfind('\n\n')
        if split_point < max_length // 2:
            # Try single newline
            split_point = chunk.rfind('\n')
        if split_point < max_length // 2:
            # Try sentence end
            for sep in ['. ', '! ', '? ', '.\n']:
                pos = chunk.rfind(sep)
                if pos > split_point:
                    split_point = pos + len(sep) - 1
        if split_point < max_length // 2:
            # Try space
            split_point = chunk.rfind(' ')
        if split_point < max_length // 2:
            # Force split
            split_point = max_length - 1

        chunks.append(remaining[:split_point + 1].rstrip())
        remaining = remaining[split_point + 1:].lstrip()

    return chunks


async def handle_whatsapp_message(
    body: str,
    from_number: str,
    to_number: str,
) -> Response:
    """
    Handle incoming WhatsApp message from Twilio webhook.
    Uses streaming to send periodic progress updates.
    """
    visitor_id = normalize_phone_number(from_number)
    conversation_id = f"whatsapp_{visitor_id}"

    logger.info(f"WhatsApp message from {visitor_id}: {body[:100]}...")

    try:
        # Collect response with periodic updates
        response_text = await process_with_updates(
            message=body,
            conversation_id=conversation_id,
            visitor_id=visitor_id,
        )

        # Send final response (split if needed)
        send_whatsapp_messages(visitor_id, response_text)

    except Exception as e:
        logger.error(f"Error processing WhatsApp message: {e}", exc_info=True)
        send_whatsapp_message(
            visitor_id,
            "Désolée, une erreur s'est produite. Réessayez dans un moment."
        )

    # Return empty TwiML
    twiml = MessagingResponse()
    return Response(content=str(twiml), media_type="application/xml")


async def process_with_updates(
    message: str,
    conversation_id: str,
    visitor_id: str,
) -> str:
    """
    Process message with streaming, sending periodic updates.
    """
    full_response = ""
    last_update_time = time.time()
    sent_thinking_message = False
    current_tool = None

    async for event in run_agent_streaming(
        message=message,
        conversation_id=conversation_id,
        conversation_context=None,
    ):
        event_type = event.get("type")

        if event_type == "token":
            full_response += event.get("content", "")

        elif event_type == "tool_start":
            current_tool = event.get("name", "recherche")

        elif event_type == "tool_end":
            current_tool = None

        elif event_type == "done":
            # Final response
            if "response" in event:
                full_response = event["response"]

        # Send periodic update if processing takes long
        elapsed = time.time() - last_update_time
        if elapsed >= PROGRESS_UPDATE_INTERVAL and not sent_thinking_message:
            if current_tool:
                update_msg = f"⏳ Je recherche des informations ({current_tool})..."
            else:
                update_msg = "⏳ Je réfléchis, un instant..."

            try:
                send_whatsapp_message(visitor_id, update_msg)
                sent_thinking_message = True
                last_update_time = time.time()
            except Exception as e:
                logger.warning(f"Failed to send progress update: {e}")

    return full_response


def send_whatsapp_message(to_number: str, message: str) -> None:
    """
    Send a single WhatsApp message via Twilio API.
    Truncates if too long.
    """
    client = get_twilio_client()

    # Truncate if needed (shouldn't happen if using send_whatsapp_messages)
    if len(message) > MAX_MESSAGE_LENGTH:
        message = message[:MAX_MESSAGE_LENGTH - 3] + "..."

    try:
        client.messages.create(
            body=message,
            from_=f"whatsapp:{settings.twilio_whatsapp_number}",
            to=f"whatsapp:{to_number}"
        )
        logger.info(f"Sent WhatsApp message to {to_number}: {message[:50]}...")
    except Exception as e:
        logger.error(f"Failed to send WhatsApp message: {e}")
        raise


def send_whatsapp_messages(to_number: str, message: str) -> None:
    """
    Send a long message as multiple WhatsApp messages.
    """
    chunks = split_message(message)

    for i, chunk in enumerate(chunks):
        # Add part indicator if multiple chunks
        if len(chunks) > 1:
            chunk = f"({i+1}/{len(chunks)}) {chunk}"

        send_whatsapp_message(to_number, chunk)

        # Small delay between messages to maintain order
        if i < len(chunks) - 1:
            time.sleep(0.5)


def register_twilio_routes(app):
    """
    Register Twilio webhook routes on a FastAPI app.
    """

    @app.post("/webhook/whatsapp")
    async def whatsapp_webhook(
        Body: str = Form(...),
        From: str = Form(...),
        To: str = Form(...),
    ):
        """Twilio WhatsApp webhook endpoint."""
        return await handle_whatsapp_message(
            body=Body,
            from_number=From,
            to_number=To,
        )

    @app.get("/webhook/whatsapp/health")
    async def whatsapp_health():
        """Health check for WhatsApp webhook."""
        twilio_configured = bool(
            settings.twilio_account_sid and
            settings.twilio_auth_token and
            settings.twilio_whatsapp_number
        )
        return {
            "status": "ok",
            "twilio_configured": twilio_configured,
            "whatsapp_number": settings.twilio_whatsapp_number if twilio_configured else None
        }
