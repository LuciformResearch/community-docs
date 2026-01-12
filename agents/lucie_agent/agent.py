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
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage
from langchain_anthropic import ChatAnthropic
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from langgraph.graph.message import add_messages

from .config import settings
from .tools import ALL_TOOLS
from .prompts import build_system_prompt


# Intent types
Intent = Literal["TECHNIQUE", "PERSONNEL", "CODE", "CONTACT", "OFF_TOPIC"]

# Contact info
CONTACT_INFO = """
Tu peux me contacter par email : **luciedefraiteur@luciformresearch.com**

Tu peux aussi :
- Voir mes projets sur GitHub : https://github.com/LuciformResearch
- Visiter mon site : https://luciformresearch.com
""".strip()

# Off-topic response
OFF_TOPIC_RESPONSE = """
Je suis là pour parler de mon travail et mes projets !

Tu peux me poser des questions sur :
- **RagForge** - Mon framework RAG avec Neo4j
- **CodeParsers** - Mon parser multi-langage
- **Mon parcours** - 42 Paris, dev 3D/jeux, IA
- **Comment me contacter**

Qu'est-ce qui t'intéresse ?
""".strip()


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
    )

    # LLM for responses (with tools)
    response_llm = ChatAnthropic(
        model=settings.model_name,
        api_key=settings.anthropic_api_key,
        temperature=settings.temperature,
        max_tokens=4096,
    ).bind_tools(ALL_TOOLS)

    # LLM for responses (without tools - faster for simple responses)
    simple_llm = ChatAnthropic(
        model=settings.model_name,
        api_key=settings.anthropic_api_key,
        temperature=settings.temperature,
        max_tokens=2048,
    )

    # Classifier node
    def classify_intent(state: AgentState) -> dict:
        """Classify the user's intent."""
        messages = state["messages"]
        # Find the last human message
        user_message = ""
        for msg in reversed(messages):
            if isinstance(msg, HumanMessage):
                user_message = msg.content
                break

        classification_prompt = f"""Classify this message into ONE of these categories:
- TECHNIQUE: Questions about projects, code, technologies, implementation details
- PERSONNEL: Questions about background, experience, motivations, personality
- CODE: Requests to see specific code examples or implementations
- CONTACT: Questions about how to contact, email, social media, website
- OFF_TOPIC: Anything unrelated to CV, work, or projects

Message: "{user_message}"

Reply with ONLY the category name (TECHNIQUE, PERSONNEL, CODE, CONTACT, or OFF_TOPIC):"""

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

        print(f"[Agent] Intent classified: {intent}")
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

    # Off-topic response
    def off_topic_response(state: AgentState) -> dict:
        """Redirect off-topic questions."""
        return {"messages": [AIMessage(content=OFF_TOPIC_RESPONSE)]}

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
) -> str:
    """
    Run the agent with a message and return the response.

    Args:
        message: The user's message
        conversation_id: The conversation ID for memory
        conversation_context: Optional previous conversation context

    Returns:
        The agent's response as a string
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

    # Run the agent
    config = {"recursion_limit": settings.max_iterations * 2}

    try:
        result = await agent.ainvoke(initial_state, config=config)

        # Extract the final AI message
        messages = result.get("messages", [])
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
                    return "\n".join(text_parts)
                return msg.content

        return "Je n'ai pas pu generer de reponse."

    except Exception as e:
        return f"Erreur lors de l'execution de l'agent: {str(e)}"


async def run_agent_streaming(
    message: str,
    conversation_id: str,
    conversation_context: str | None = None
):
    """
    Run the agent with streaming output.

    Yields chunks of the response as they are generated.
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
                                    yield {"type": "token", "content": block.get("text", "")}
                                elif isinstance(block, str):
                                    yield {"type": "token", "content": block}
                        else:
                            yield {"type": "token", "content": content}

            elif kind == "on_tool_start":
                # Tool is starting
                tool_name = event.get("name", "unknown")
                yield {"type": "tool_start", "name": tool_name}

            elif kind == "on_tool_end":
                # Tool finished
                tool_name = event.get("name", "unknown")
                output = event.get("data", {}).get("output", "")
                yield {"type": "tool_end", "name": tool_name, "output": str(output)[:500]}

    except Exception as e:
        yield {"type": "error", "content": str(e)}
