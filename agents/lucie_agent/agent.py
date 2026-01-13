"""
LangGraph agent definition for Lucie persona.

This implements a graph-based agent with intent routing:
- TECHNIQUE: Search knowledge base
- PERSONNEL: Direct persona response
- CODE: Get code samples
- CONTACT: Return contact info
- OFF_TOPIC: Polite redirect

See ARCHITECTURE.md for full documentation.
"""

import asyncio
from typing import TypedDict, Annotated, Sequence, Literal
from datetime import datetime
from pathlib import Path
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage
from langchain_anthropic import ChatAnthropic
from . import retry as retry_module
from .retry import ChatAnthropicWithRetry, set_retry_event_queue
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from langgraph.graph.message import add_messages
from collections import defaultdict

from .config import settings
from .tools import ALL_TOOLS
from .prompts import build_system_prompt
from .summarizer import summarize_tool_calls, format_summaries_for_context, ToolCallSummary
from .retry import is_rate_limit_error


# Tool call type
class ToolCall(TypedDict):
    """A single tool call with args and result."""
    name: str
    args: dict
    result: str
    preview: str


# Response type for run_agent
class AgentResponse(TypedDict):
    """Response from running the agent."""
    response: str
    tool_summary: ToolCallSummary | None
    tool_calls: list[ToolCall]  # Raw tool calls for storage


# Log file for agent/classifier
AGENT_LOG_FILE = Path(__file__).parent / "agent.log"

# Configure retry module to use the same log file
retry_module.RETRY_LOG_FILE = AGENT_LOG_FILE


def _log_agent(message: str):
    """Write to agent log file (no truncation)."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_line = f"[{timestamp}] {message}"
    print(log_line)
    with open(AGENT_LOG_FILE, "a", encoding="utf-8") as f:
        f.write(log_line + "\n")


# Intent types
Intent = Literal["TECHNIQUE", "PERSONNEL", "CODE", "CONTACT", "OFF_TOPIC"]

# Contact info
CONTACT_INFO = """
Tu peux me contacter par email : **luciedefraiteur@luciformresearch.com**

Tu peux aussi :
- Voir mes projets sur GitHub : https://github.com/LuciformResearch
- Visiter mon site : https://luciformresearch.com
""".strip()

# Off-topic guidance (included in system prompt context)
OFF_TOPIC_GUIDANCE = """
Si la question est hors-sujet (pas liée à mon travail/projets), redirige poliment vers mes domaines d'expertise.
"""


# Language type
Language = Literal["FR", "EN"]

# Agent state with intent and language
class AgentState(TypedDict):
    """State for the agent graph."""
    messages: Annotated[Sequence[BaseMessage], add_messages]
    conversation_id: str
    intent: Intent | None
    language: Language | None


def create_agent(model_name: str | None = None):
    """
    Create and return the compiled LangGraph agent with intent routing.

    Args:
        model_name: Override model name (default: settings.model_name)
    """
    use_model = model_name or settings.model_name
    _log_agent(f"Creating agent with model: {use_model}")

    # LLM for classification (fast, cheap) - always use Haiku
    # Using ChatAnthropicWithRetry for proper exponential backoff on rate limits
    classifier_llm = ChatAnthropicWithRetry(
        model="claude-3-5-haiku-20241022",
        api_key=settings.anthropic_api_key,
        temperature=0,
        max_tokens=50,
        # Custom retry config (shorter delays for classifier since it's fast)
        retry_max_attempts=5,
        retry_base_delay_ms=30000,  # 30 seconds for classifier (smaller requests)
    )

    # LLM for responses (with tools)
    # Using ChatAnthropicWithRetry for proper exponential backoff on rate limits
    response_llm = ChatAnthropicWithRetry(
        model=use_model,
        api_key=settings.anthropic_api_key,
        temperature=settings.temperature,
        max_tokens=4096,
        # Custom retry config (longer delays for main LLM due to larger requests)
        retry_max_attempts=5,
        retry_base_delay_ms=60000,  # 1 minute base delay
    ).bind_tools(ALL_TOOLS)

    # LLM for responses (without tools - always Haiku for speed/cost)
    simple_llm = ChatAnthropicWithRetry(
        model="claude-3-5-haiku-20241022",
        api_key=settings.anthropic_api_key,
        temperature=settings.temperature,
        max_tokens=2048,
        retry_max_attempts=5,
        retry_base_delay_ms=30000,  # Shorter delay for Haiku
    )

    # Classifier node
    def classify_intent(state: AgentState) -> dict:
        """Classify the user's intent with conversation context."""
        messages = state["messages"]
        conversation_id = state.get("conversation_id", "")

        # Find the last human message and previous assistant message for context
        user_message = ""
        last_assistant_message = ""

        for msg in reversed(messages):
            if isinstance(msg, HumanMessage) and not user_message:
                user_message = msg.content
            elif isinstance(msg, AIMessage) and not last_assistant_message:
                # Get the last assistant message for context (full content for better classification)
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                last_assistant_message = content
            if user_message and last_assistant_message:
                break

        # Build context-aware classification prompt
        # Note: Tool summaries are now included in conversation_context from community-docs API
        context_section = ""
        if last_assistant_message:
            context_section = f"""
Previous assistant message (for context): "{last_assistant_message}"
"""

        classification_prompt = f"""Classify this message. Output ONLY "CATEGORY|LANG", nothing else.

CATEGORIES:
- TECHNIQUE: projects, code, tech, implementation, follow-ups like "ok/oui/continue"
- PERSONNEL: background, experience, motivations, personality
- CODE: requests to see specific code examples
- CONTACT: email, social media, how to reach
- OFF_TOPIC: unrelated to work/projects

LANG: FR=French, EN=English/other
{context_section}
Message: "{user_message}"

Output:"""

        # Log the full classifier prompt
        _log_agent(f"\n{'='*80}")
        _log_agent(f"CLASSIFIER - Conversation: {conversation_id}")
        _log_agent(f"{'='*80}")
        _log_agent(f"USER MESSAGE: {user_message}")
        _log_agent(f"LAST ASSISTANT: {last_assistant_message}")
        _log_agent(f"{'-'*80}")
        _log_agent(f"FULL CLASSIFICATION PROMPT:\n{classification_prompt}")
        _log_agent(f"{'-'*80}")

        response = classifier_llm.invoke([HumanMessage(content=classification_prompt)])
        response_text = response.content.strip().upper()

        # Parse intent and language (format: "CATEGORY|LANGUAGE")
        # Only take the first line in case LLM adds extra text
        first_line = response_text.split("\n")[0].strip()
        parts = first_line.split("|")
        intent_text = parts[0].strip() if parts else ""
        language_text = parts[1].strip() if len(parts) > 1 else "EN"

        # Parse intent
        if "TECHNIQUE" in intent_text:
            intent = "TECHNIQUE"
        elif "PERSONNEL" in intent_text:
            intent = "PERSONNEL"
        elif "CODE" in intent_text:
            intent = "CODE"
        elif "CONTACT" in intent_text:
            intent = "CONTACT"
        else:
            intent = "OFF_TOPIC"

        # Parse language
        language: Language = "FR" if "FR" in language_text else "EN"

        _log_agent(f"CLASSIFIER RAW RESPONSE: {repr(response_text)}")
        _log_agent(f"FIRST LINE: {repr(first_line)}")
        _log_agent(f"PARSED INTENT: {intent}, LANGUAGE: {language}")
        _log_agent(f"{'='*80}\n")

        return {"intent": intent, "language": language}

    # Helper to build messages with correct language prompt
    def build_messages_for_llm(state: AgentState) -> list[BaseMessage]:
        """Build message list with language-appropriate system prompt."""
        language = state.get("language", "FR")
        messages = list(state["messages"])

        # Find and extract conversation context from original system message
        conversation_context = None
        human_messages = []

        for msg in messages:
            if isinstance(msg, SystemMessage):
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                if "## Contexte de conversation" in content:
                    parts = content.split("## Contexte de conversation")
                    if len(parts) > 1:
                        conversation_context = parts[1].strip()
                elif "## Conversation context" in content:
                    parts = content.split("## Conversation context")
                    if len(parts) > 1:
                        conversation_context = parts[1].strip()
            else:
                human_messages.append(msg)

        # Build new system prompt with detected language
        system_prompt = build_system_prompt(conversation_context, language)

        _log_agent(f"[BUILD_MESSAGES] Language: {language}")

        return [SystemMessage(content=system_prompt)] + human_messages

    # Route based on intent
    def route_by_intent(state: AgentState) -> str:
        """Route to the appropriate handler based on intent."""
        intent = state.get("intent", "TECHNIQUE")
        if intent in ("TECHNIQUE", "CODE"):
            return "agent_with_tools"
        elif intent == "CONTACT":
            return "contact_response"
        elif intent == "OFF_TOPIC":
            return "off_topic_response"
        else:  # PERSONNEL
            return "persona_response"

    # Agent with tools (for TECHNIQUE and CODE)
    def call_model_with_tools(state: AgentState) -> dict:
        """Call the LLM with tools for technical questions."""
        messages = build_messages_for_llm(state)
        response = response_llm.invoke(messages)
        return {"messages": [response]}

    # Simple persona response (for PERSONNEL)
    def call_persona_response(state: AgentState) -> dict:
        """Direct persona response without tools."""
        messages = build_messages_for_llm(state)
        response = simple_llm.invoke(messages)
        return {"messages": [response]}

    # Contact response
    def contact_response(state: AgentState) -> dict:
        """Return contact information."""
        return {"messages": [AIMessage(content=CONTACT_INFO)]}

    # Off-topic response (now uses LLM for context-aware redirection)
    def off_topic_response(state: AgentState) -> dict:
        """Redirect off-topic questions with context awareness."""
        messages = build_messages_for_llm(state)
        response = simple_llm.invoke(messages)
        return {"messages": [response]}

    # Should continue with tools?
    def should_continue(state: AgentState) -> str:
        """Determine if we should continue to tools or end."""
        messages = state["messages"]
        last_message = messages[-1]

        if hasattr(last_message, "tool_calls") and last_message.tool_calls:
            return "tools"
        return END

    # Create the graph
    workflow = StateGraph(AgentState)

    # Add nodes
    workflow.add_node("classifier", classify_intent)
    workflow.add_node("agent_with_tools", call_model_with_tools)
    workflow.add_node("persona_response", call_persona_response)
    workflow.add_node("contact_response", contact_response)
    workflow.add_node("off_topic_response", off_topic_response)
    workflow.add_node("tools", ToolNode(ALL_TOOLS))

    # Set entry point
    workflow.set_entry_point("classifier")

    # Route from classifier based on intent (handlers build their own prompts with detected language)
    workflow.add_conditional_edges(
        "classifier",
        route_by_intent,
        {
            "agent_with_tools": "agent_with_tools",
            "persona_response": "persona_response",
            "contact_response": "contact_response",
            "off_topic_response": "off_topic_response",
        }
    )

    # Agent with tools can call tools or end
    workflow.add_conditional_edges(
        "agent_with_tools",
        should_continue,
        {
            "tools": "tools",
            END: END,
        }
    )

    # Tools return to agent
    workflow.add_edge("tools", "agent_with_tools")

    # Simple responses go directly to END
    workflow.add_edge("persona_response", END)
    workflow.add_edge("contact_response", END)
    workflow.add_edge("off_topic_response", END)

    # Compile the graph
    return workflow.compile()


# Global agent instances (primary and fallback)
_primary_agent = None
_fallback_agent = None


def get_agent(use_fallback: bool = False):
    """Get or create the agent instance (primary or fallback)."""
    global _primary_agent, _fallback_agent

    if use_fallback:
        if _fallback_agent is None:
            _log_agent(f"Creating FALLBACK agent with model: {settings.fallback_model_name}")
            _fallback_agent = create_agent(model_name=settings.fallback_model_name)
        return _fallback_agent
    else:
        if _primary_agent is None:
            _log_agent(f"Creating PRIMARY agent with model: {settings.model_name}")
            _primary_agent = create_agent(model_name=settings.model_name)
        return _primary_agent


async def run_agent(
    message: str,
    conversation_id: str,
    conversation_context: str | None = None
) -> AgentResponse:
    """
    Run the agent with a message and return the response with tool summary.

    Args:
        message: The user's message
        conversation_id: The conversation ID for memory
        conversation_context: Optional previous conversation context

    Returns:
        AgentResponse with response text and optional tool_summary
    """
    agent = get_agent()

    # Build initial system prompt (will be replaced after language detection)
    system_prompt = build_system_prompt(conversation_context, "FR")

    # Create initial state
    initial_state: AgentState = {
        "messages": [
            SystemMessage(content=system_prompt),
            HumanMessage(content=message),
        ],
        "conversation_id": conversation_id,
        "intent": None,
        "language": None,
    }

    # Run the agent (retry logic is built into ChatAnthropic with max_retries)
    config = {"recursion_limit": settings.max_iterations * 2}

    try:
        result = await agent.ainvoke(initial_state, config=config)

        # Extract messages
        messages = result.get("messages", [])

        # Extract tool calls from messages for summarization
        tool_calls = []
        for msg in messages:
            if isinstance(msg, AIMessage) and hasattr(msg, "tool_calls") and msg.tool_calls:
                for tc in msg.tool_calls:
                    tool_calls.append({
                        "name": tc.get("name", "unknown"),
                        "args": tc.get("args", {}),
                        "result": ""  # Will be filled from ToolMessage
                    })
            elif isinstance(msg, ToolMessage):
                # Match tool result with the corresponding call
                if tool_calls and not tool_calls[-1]["result"]:
                    result_str = str(msg.content)
                    tool_calls[-1]["result"] = result_str
                    # Add preview (first 500 chars)
                    tool_calls[-1]["preview"] = result_str[:500] + "..." if len(result_str) > 500 else result_str

        # Extract the final AI message
        response_text = ""
        for msg in reversed(messages):
            if isinstance(msg, AIMessage) and msg.content:
                # Return content, handling potential list format
                if isinstance(msg.content, list):
                    # Extract text from content blocks
                    text_parts = []
                    for block in msg.content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif isinstance(block, str):
                            text_parts.append(block)
                    response_text = "\n".join(text_parts)
                else:
                    response_text = msg.content
                break

        if not response_text:
            response_text = "Je n'ai pas pu generer de reponse."

        # Generate tool summary if tools were called
        tool_summary = None
        if tool_calls:
            _log_agent(f"\n{'='*80}")
            _log_agent(f"GENERATING SUMMARY (non-streaming) - {len(tool_calls)} tool call(s)")
            _log_agent(f"Conversation: {conversation_id}")
            _log_agent(f"{'='*80}")

            tool_summary = summarize_tool_calls(message, tool_calls, response_text)
            if tool_summary:
                _log_agent(f"SUMMARY GENERATED:")
                _log_agent(f"  key_findings: {tool_summary['key_findings']}")
                _log_agent(f"  assistant_action: {tool_summary['assistant_action']}")
            _log_agent(f"{'='*80}\n")

        return {
            "response": response_text,
            "tool_summary": tool_summary,
            "tool_calls": tool_calls
        }

    except Exception as e:
        _log_agent(f"❌ Agent error: {str(e)}")
        return {
            "response": f"Erreur lors de l'execution de l'agent: {str(e)}",
            "tool_summary": None,
            "tool_calls": []
        }


async def run_agent_streaming(
    message: str,
    conversation_id: str,
    conversation_context: str | None = None
):
    """
    Run the agent with streaming output.

    Yields chunks of the response as they are generated.
    Also captures tool calls and generates summaries.

    Retry logic:
    - Try with primary model (Sonnet)
    - On rate limit: retry up to 2 times with exponential backoff
    - After 2 failed retries: fallback to Haiku model
    """
    import random

    # Retry configuration
    MAX_RETRIES_BEFORE_FALLBACK = 2
    BASE_DELAY_MS = 60000  # 1 minute
    BACKOFF_MULTIPLIER = 1.5
    MAX_JITTER_MS = 10000

    # Build initial system prompt (will be replaced after language detection)
    system_prompt = build_system_prompt(conversation_context, "FR")

    # Create initial state
    initial_state: AgentState = {
        "messages": [
            SystemMessage(content=system_prompt),
            HumanMessage(content=message),
        ],
        "conversation_id": conversation_id,
        "intent": None,
        "language": None,
    }

    config = {"recursion_limit": settings.max_iterations * 2}

    async def stream_with_agent(agent, model_name: str):
        """Inner function to stream with a specific agent."""
        tool_calls = []
        current_tool = None
        full_response = ""

        async for event in agent.astream_events(initial_state, config=config, version="v2"):
            kind = event.get("event")

            # Get the current node from metadata to filter classifier tokens
            metadata = event.get("metadata", {})
            langgraph_node = metadata.get("langgraph_node", "")

            if kind == "on_chat_model_stream":
                # Skip classifier tokens - only stream from response nodes
                if langgraph_node == "classifier":
                    continue

                # Streaming token from the LLM
                chunk = event.get("data", {}).get("chunk")
                if chunk and hasattr(chunk, "content"):
                    content = chunk.content
                    if content:
                        # Handle both string and list content
                        if isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "text":
                                    text = block.get("text", "")
                                    full_response += text
                                    yield {"type": "token", "content": text}
                                elif isinstance(block, str):
                                    full_response += block
                                    yield {"type": "token", "content": block}
                        else:
                            full_response += content
                            yield {"type": "token", "content": content}

            elif kind == "on_tool_start":
                # Tool is starting
                tool_name = event.get("name", "unknown")
                tool_input = event.get("data", {}).get("input", {})
                current_tool = {"name": tool_name, "args": tool_input}
                yield {"type": "tool_start", "name": tool_name, "args": tool_input}

            elif kind == "on_tool_end":
                # Tool finished
                tool_name = event.get("name", "unknown")
                raw_output = event.get("data", {}).get("output", "")
                # Extract actual content from tool output
                if hasattr(raw_output, "content"):
                    output_str = str(raw_output.content)
                elif isinstance(raw_output, dict) and "content" in raw_output:
                    output_str = str(raw_output["content"])
                else:
                    output_str = str(raw_output)
                if current_tool:
                    current_tool["result"] = output_str
                    tool_calls.append(current_tool)
                    current_tool = None
                yield {"type": "tool_end", "name": tool_name, "output": output_str}

        # Generate and yield summary if tools were called
        if tool_calls:
            _log_agent(f"\n{'='*80}")
            _log_agent(f"GENERATING SUMMARY ({model_name}) - {len(tool_calls)} tool call(s)")
            _log_agent(f"Conversation: {conversation_id}")
            _log_agent(f"{'='*80}")

            summary = summarize_tool_calls(message, tool_calls, full_response)
            if summary:
                _log_agent(f"SUMMARY GENERATED:")
                _log_agent(f"  key_findings: {summary['key_findings']}")
                _log_agent(f"  assistant_action: {summary['assistant_action']}")
                yield {
                    "type": "tool_summary",
                    "user_question": summary["user_question"],
                    "tools_used": summary["tools_used"],
                    "key_findings": summary["key_findings"],
                    "assistant_action": summary["assistant_action"],
                }
            _log_agent(f"{'='*80}\n")

    # Main retry loop
    attempt = 0
    use_fallback = False

    while True:
        try:
            agent = get_agent(use_fallback=use_fallback)
            model_name = settings.fallback_model_name if use_fallback else settings.model_name

            _log_agent(f"[STREAM] Starting with model: {model_name} (attempt {attempt + 1}, fallback={use_fallback})")

            # Yield model info for frontend
            if use_fallback:
                yield {"type": "model_fallback", "model": model_name}

            async for event in stream_with_agent(agent, model_name):
                yield event

            # Success - exit retry loop
            break

        except Exception as e:
            error_str = str(e)
            _log_agent(f"[STREAM] Error on attempt {attempt + 1}: {error_str}")

            # Check if it's a rate limit error
            if not is_rate_limit_error(e):
                _log_agent(f"[STREAM] Non-rate-limit error, not retrying")
                yield {"type": "error", "content": error_str}
                break

            # Rate limit error - check if we should retry or fallback
            if not use_fallback and attempt < MAX_RETRIES_BEFORE_FALLBACK:
                # Calculate delay with exponential backoff + jitter
                jitter = random.random() * MAX_JITTER_MS
                delay_ms = BASE_DELAY_MS * (BACKOFF_MULTIPLIER ** attempt) + jitter
                delay_seconds = delay_ms / 1000

                _log_agent(f"[STREAM] Rate limited, retry {attempt + 1}/{MAX_RETRIES_BEFORE_FALLBACK} in {delay_seconds:.1f}s")

                # Emit retry event for frontend
                yield {
                    "type": "rate_limit",
                    "attempt": attempt + 1,
                    "max_attempts": MAX_RETRIES_BEFORE_FALLBACK,
                    "delay_seconds": round(delay_seconds, 1),
                    "will_fallback": False,
                }

                await asyncio.sleep(delay_seconds)
                attempt += 1

            elif not use_fallback:
                # Max retries reached, switch to fallback
                _log_agent(f"[STREAM] Max retries reached, switching to fallback model: {settings.fallback_model_name}")

                yield {
                    "type": "rate_limit",
                    "attempt": attempt + 1,
                    "max_attempts": MAX_RETRIES_BEFORE_FALLBACK,
                    "delay_seconds": 5,
                    "will_fallback": True,
                    "fallback_model": settings.fallback_model_name,
                }

                await asyncio.sleep(5)  # Short delay before fallback
                use_fallback = True
                attempt = 0  # Reset attempt counter for fallback

            else:
                # Even fallback failed - give up
                _log_agent(f"[STREAM] Fallback model also rate limited, giving up")
                yield {"type": "error", "content": f"Rate limit on both models: {error_str}"}
                break
