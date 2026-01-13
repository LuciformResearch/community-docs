"""
Retry utilities with exponential backoff for LLM API calls.

Based on ragforge-core patterns for handling rate limits (429 errors).
"""

import asyncio
import random
import time
from typing import TypeVar, Callable, Awaitable, Any, List, Optional
from datetime import datetime
from pathlib import Path

from langchain_core.messages import BaseMessage
from langchain_core.outputs import ChatResult
from langchain_anthropic import ChatAnthropic
from pydantic import Field

T = TypeVar('T')

# Log files for retry events
RETRY_LOG_FILE = None  # Will be set from agent.py (agent.log)
CONVERSATION_LOG_FILE = None  # Will be set from main.py (conversation.log)

# Global async queue for retry events (set per-request for streaming)
# This allows the streaming endpoint to receive retry notifications
_retry_event_queue: Optional[asyncio.Queue] = None


def set_retry_event_queue(queue: Optional[asyncio.Queue]):
    """Set the queue for retry events (call at start of each request)."""
    global _retry_event_queue
    _retry_event_queue = queue


def get_retry_event_queue() -> Optional[asyncio.Queue]:
    """Get the current retry event queue."""
    return _retry_event_queue


async def _emit_retry_event(attempt: int, max_attempts: int, delay_seconds: float):
    """Emit a retry event to the queue if one is set."""
    if _retry_event_queue is not None:
        try:
            await _retry_event_queue.put({
                "type": "rate_limit",
                "attempt": attempt,
                "max_attempts": max_attempts,
                "delay_seconds": round(delay_seconds, 1),
            })
        except Exception:
            pass  # Don't fail if queue is closed


def _log_retry(message: str):
    """Log retry events."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_line = f"[{timestamp}] [RETRY] {message}"
    print(log_line)
    if RETRY_LOG_FILE:
        with open(RETRY_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(log_line + "\n")


def is_rate_limit_error(error: Exception) -> bool:
    """
    Check if an error is a rate limit error.

    Detects:
    - HTTP 429 errors
    - Rate limit messages
    - Quota exceeded
    - Resource exhausted (Google style)
    - Overloaded errors (Anthropic style)
    """
    message = str(error).lower()
    return any(indicator in message for indicator in [
        '429',
        'rate limit',
        'rate_limit',
        'ratelimit',
        'quota',
        'exhausted',
        'resource_exhausted',
        'too many requests',
        'overloaded',
    ])


async def retry_with_backoff(
    fn: Callable[[], Awaitable[T]],
    max_retries: int = 5,
    base_delay_ms: int = 60000,  # 1 minute - Anthropic rate limits are per-minute
    backoff_multiplier: float = 1.5,
    max_jitter_ms: int = 10000,  # 0-10 seconds of jitter
    operation_name: str = "LLM call"
) -> T:
    """
    Execute an async function with exponential backoff retry on rate limit errors.

    Args:
        fn: Async function to execute
        max_retries: Maximum number of retry attempts (default: 5)
        base_delay_ms: Base delay in milliseconds (default: 60000 = 1 minute)
        backoff_multiplier: Multiplier for exponential backoff (default: 1.5)
        max_jitter_ms: Maximum random jitter to add (default: 10000 = 10 seconds)
        operation_name: Name for logging purposes

    Returns:
        Result of the function call

    Raises:
        The original exception if max retries exceeded or non-rate-limit error
    """
    last_error: Exception | None = None

    for attempt in range(max_retries + 1):
        try:
            return await fn()
        except Exception as error:
            last_error = error

            # Check if it's a rate limit error
            if not is_rate_limit_error(error):
                _log_retry(f"Non-rate-limit error on {operation_name}: {error}")
                raise

            # Check if we have retries left
            if attempt >= max_retries:
                _log_retry(f"Max retries ({max_retries}) exceeded for {operation_name}")
                raise

            # Calculate delay with exponential backoff + jitter
            jitter = random.random() * max_jitter_ms
            delay_ms = base_delay_ms * (backoff_multiplier ** attempt) + jitter
            delay_seconds = delay_ms / 1000

            _log_retry(
                f"Rate limited on {operation_name} (attempt {attempt + 1}/{max_retries + 1}). "
                f"Retrying in {delay_seconds:.1f}s..."
            )

            # Emit retry event for streaming UI
            await _emit_retry_event(attempt + 1, max_retries + 1, delay_seconds)

            await asyncio.sleep(delay_seconds)

    # Should never reach here, but just in case
    if last_error:
        raise last_error
    raise RuntimeError(f"Unexpected state in retry_with_backoff for {operation_name}")


def retry_sync_with_backoff(
    fn: Callable[[], T],
    max_retries: int = 5,
    base_delay_ms: int = 60000,
    backoff_multiplier: float = 1.5,
    max_jitter_ms: int = 10000,
    operation_name: str = "LLM call"
) -> T:
    """
    Synchronous version of retry_with_backoff.

    Same parameters as retry_with_backoff but for synchronous functions.
    """
    import time

    last_error: Exception | None = None

    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as error:
            last_error = error

            if not is_rate_limit_error(error):
                _log_retry(f"Non-rate-limit error on {operation_name}: {error}")
                raise

            if attempt >= max_retries:
                _log_retry(f"Max retries ({max_retries}) exceeded for {operation_name}")
                raise

            jitter = random.random() * max_jitter_ms
            delay_ms = base_delay_ms * (backoff_multiplier ** attempt) + jitter
            delay_seconds = delay_ms / 1000

            _log_retry(
                f"Rate limited on {operation_name} (attempt {attempt + 1}/{max_retries + 1}). "
                f"Retrying in {delay_seconds:.1f}s..."
            )

            time.sleep(delay_seconds)

    if last_error:
        raise last_error
    raise RuntimeError(f"Unexpected state in retry_sync_with_backoff for {operation_name}")


class ChatAnthropicWithRetry(ChatAnthropic):
    """
    ChatAnthropic wrapper with custom exponential backoff retry for rate limits.

    LangChain's built-in max_retries doesn't wait long enough between retries
    for rate limit errors (Anthropic has per-minute limits). This wrapper adds
    proper exponential backoff with ~60s base delay.
    """

    # Retry configuration (pydantic fields)
    retry_max_attempts: int = Field(default=5, description="Maximum retry attempts")
    retry_base_delay_ms: int = Field(default=60000, description="Base delay in ms (1 minute)")
    retry_backoff_multiplier: float = Field(default=1.5, description="Backoff multiplier")
    retry_max_jitter_ms: int = Field(default=10000, description="Max jitter in ms (0-10s)")

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        """Override _generate to add retry logic."""
        return retry_sync_with_backoff(
            fn=lambda: super(ChatAnthropicWithRetry, self)._generate(
                messages, stop, run_manager, **kwargs
            ),
            max_retries=self.retry_max_attempts,
            base_delay_ms=self.retry_base_delay_ms,
            backoff_multiplier=self.retry_backoff_multiplier,
            max_jitter_ms=self.retry_max_jitter_ms,
            operation_name=f"ChatAnthropic._generate ({self.model})"
        )

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        """Override _agenerate to add retry logic."""
        return await retry_with_backoff(
            fn=lambda: super(ChatAnthropicWithRetry, self)._agenerate(
                messages, stop, run_manager, **kwargs
            ),
            max_retries=self.retry_max_attempts,
            base_delay_ms=self.retry_base_delay_ms,
            backoff_multiplier=self.retry_backoff_multiplier,
            max_jitter_ms=self.retry_max_jitter_ms,
            operation_name=f"ChatAnthropic._agenerate ({self.model})"
        )
