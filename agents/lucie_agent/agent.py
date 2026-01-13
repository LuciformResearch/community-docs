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

from typing import TypedDict, Annotated, Sequence, Literal
from datetime import datetime
from pathlib import Path
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage
from langchain_anthropic import ChatAnthropic
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from langgraph.graph.message import add_messages
from collections import defaultdict

from .config import settings
from .tools import ALL_TOOLS
from .prompts import build_system_prompt
from .summarizer import summarize_tool_calls, format_summaries_for_context, ToolCallSummary


# Response type for run_agent
class AgentResponse(TypedDict):
    """Response from running the agent."""
    response: str
    tool_summary: ToolCallSummary | None


# Log file for agent/classifier
AGENT_LOG_FILE = Path(__file__).parent / "agent.log"


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


# Agent state with intent
class AgentState(TypedDict):
    """State for the agent graph."""
    messages: Annotated[Sequence[BaseMessage], add_messages]
    conversation_id: str
    intent: Intent | None


def create_agent():
    """Create and return the compiled LangGraph agent with intent routing."""

    # LLM for classification (fast, cheap)
    classifier_llm = ChatAnthropic(
        model="claude-3-5-haiku-20241022",
        api_key=settings.anthropic_api_key,
        temperature=0,
        max_tokens=50,
        max_retries=3,  # Built-in retry for rate limits
    )

    # LLM for responses (with tools)
    response_llm = ChatAnthropic(
        model=settings.model_name,
        api_key=settings.anthropic_api_key,
        temperature=settings.temperature,
        max_tokens=4096,
        max_retries=3,  # Built-in retry for rate limits
    ).bind_tools(ALL_TOOLS)

    # LLM for responses (without tools - faster for simple responses)
    simple_llm = ChatAnthropic(
        model=settings.model_name,
        api_key=settings.anthropic_api_key,
        temperature=settings.temperature,
        max_tokens=2048,
        max_retries=3,  # Built-in retry for rate limits
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
                # Get a snippet of the last assistant message for context
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                last_assistant_message = content[:300] if len(content) > 300 else content
            if user_message and last_assistant_message:
                break

        # Build context-aware classification prompt
        # Note: Tool summaries are now included in conversation_context from community-docs API
        context_section = ""
        if last_assistant_message:
            context_section = f"""
Previous assistant message (for context): "{last_assistant_message}"
"""

        classification_prompt = f"""Classify this message into ONE of these categories:
- TECHNIQUE: Questions about projects, code, technologies, implementation details, OR follow-up/confirmation to technical discussions (like "oui", "ok", "continue")
- PERSONNEL: Questions about background, experience, motivations, personality
- CODE: Requests to see specific code examples or implementations
- CONTACT: Questions about how to contact, email, social media, website
- OFF_TOPIC: Anything clearly unrelated to CV, work, or projects
{context_section}
User message: "{user_message}"

Reply with ONLY the category name (TECHNIQUE, PERSONNEL, CODE, CONTACT, or OFF_TOPIC):"""

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
        intent_text = response.content.strip().upper()

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

        _log_agent(f"CLASSIFIER RESPONSE: {intent_text}")
        _log_agent(f"PARSED INTENT: {intent}")
        _log_agent(f"{'='*80}\n")

        return {"intent": intent}

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
        messages = state["messages"]
        response = response_llm.invoke(messages)
        return {"messages": [response]}

    # Simple persona response (for PERSONNEL)
    def call_persona_response(state: AgentState) -> dict:
        """Direct persona response without tools."""
        messages = state["messages"]
        response = simple_llm.invoke(messages)
        return {"messages": [response]}

    # Contact response
    def contact_response(state: AgentState) -> dict:
        """Return contact information."""
        return {"messages": [AIMessage(content=CONTACT_INFO)]}

    # Off-topic response (now uses LLM for context-aware redirection)
    def off_topic_response(state: AgentState) -> dict:
        """Redirect off-topic questions with context awareness."""
        messages = state["messages"]
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

    # Route from classifier based on intent
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


# Global agent instance
_agent = None


def get_agent():
    """Get or create the agent instance."""
    global _agent
    if _agent is None:
        _agent = create_agent()
    return _agent


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

    # Build system prompt with context
    system_prompt = build_system_prompt(conversation_context)

    # Create initial state
    initial_state: AgentState = {
        "messages": [
            SystemMessage(content=system_prompt),
            HumanMessage(content=message),
        ],
        "conversation_id": conversation_id,
        "intent": None,
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
                    tool_calls[-1]["result"] = str(msg.content)

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
            "tool_summary": tool_summary
        }

    except Exception as e:
        _log_agent(f"❌ Agent error: {str(e)}")
        return {
            "response": f"Erreur lors de l'execution de l'agent: {str(e)}",
            "tool_summary": None
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
    """
    agent = get_agent()

    # Build system prompt with context
    system_prompt = build_system_prompt(conversation_context)

    # Create initial state
    initial_state: AgentState = {
        "messages": [
            SystemMessage(content=system_prompt),
            HumanMessage(content=message),
        ],
        "conversation_id": conversation_id,
        "intent": None,
    }

    config = {"recursion_limit": settings.max_iterations * 2}

    # Track tool calls for summarization
    tool_calls = []
    current_tool = None
    full_response = ""

    try:
        async for event in agent.astream_events(initial_state, config=config, version="v2"):
            kind = event.get("event")

            if kind == "on_chat_model_stream":
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
                yield {"type": "tool_start", "name": tool_name}

            elif kind == "on_tool_end":
                # Tool finished
                tool_name = event.get("name", "unknown")
                output = event.get("data", {}).get("output", "")
                if current_tool:
                    current_tool["result"] = str(output)
                    tool_calls.append(current_tool)
                    current_tool = None
                yield {"type": "tool_end", "name": tool_name, "output": str(output)[:500]}

        # Generate and yield summary if tools were called
        if tool_calls:
            _log_agent(f"\n{'='*80}")
            _log_agent(f"GENERATING SUMMARY - {len(tool_calls)} tool call(s)")
            _log_agent(f"Conversation: {conversation_id}")
            _log_agent(f"{'='*80}")

            summary = summarize_tool_calls(message, tool_calls, full_response)
            if summary:
                _log_agent(f"SUMMARY GENERATED:")
                _log_agent(f"  key_findings: {summary['key_findings']}")
                _log_agent(f"  assistant_action: {summary['assistant_action']}")
                # Yield summary event for main.py to store via API
                yield {
                    "type": "tool_summary",
                    "user_question": summary["user_question"],
                    "tools_used": summary["tools_used"],
                    "key_findings": summary["key_findings"],
                    "assistant_action": summary["assistant_action"],
                }
            _log_agent(f"{'='*80}\n")

    except Exception as e:
        yield {"type": "error", "content": str(e)}
