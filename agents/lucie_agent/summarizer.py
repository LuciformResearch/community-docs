"""
Tool call summarizer for Lucie Agent.

Uses Haiku to generate concise summaries of tool calls between user and assistant turns.
These summaries help the classifier and agent understand what was discussed/found.
"""

from typing import TypedDict, Optional
from datetime import datetime
from pathlib import Path
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage

from .config import settings


# Log file for summarization
SUMMARY_LOG_FILE = Path(__file__).parent / "summary.log"


def _log_summary(message: str):
    """Write to summary log file (no truncation)."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_line = f"[{timestamp}] {message}"
    print(log_line)
    with open(SUMMARY_LOG_FILE, "a", encoding="utf-8") as f:
        f.write(log_line + "\n")


# Summary of a tool call turn
class ToolCallSummary(TypedDict):
    """Summary of tool calls in a single turn."""
    user_question: str          # What the user asked
    tools_used: list[str]       # List of tool names used
    key_findings: str           # What was found (files, code snippets, line numbers)
    assistant_action: str       # What the assistant did with the results


# Summarizer using Haiku
_summarizer_llm: ChatAnthropic | None = None


def get_summarizer() -> ChatAnthropic:
    """Get or create the Haiku summarizer."""
    global _summarizer_llm
    if _summarizer_llm is None:
        _summarizer_llm = ChatAnthropic(
            model="claude-3-5-haiku-20241022",
            api_key=settings.anthropic_api_key,
            temperature=0,
            max_tokens=500,
            max_retries=3,  # Built-in retry for rate limits
        )
    return _summarizer_llm


def summarize_tool_calls(
    user_message: str,
    tool_calls: list[dict],
    assistant_response: str
) -> ToolCallSummary | None:
    """
    Generate a concise summary of tool calls in a turn.

    Args:
        user_message: What the user asked
        tool_calls: List of tool calls with {name, args, result}
        assistant_response: The assistant's final response

    Returns:
        A ToolCallSummary or None if no tool calls were made
    """
    if not tool_calls:
        return None

    _log_summary(f"\n{'='*80}")
    _log_summary(f"SUMMARIZING {len(tool_calls)} TOOL CALL(S)")
    _log_summary(f"{'='*80}")
    _log_summary(f"USER QUESTION: {user_message}")
    _log_summary(f"{'-'*80}")

    llm = get_summarizer()

    # Format tool calls for the prompt - log full details
    tool_details = []
    for i, tc in enumerate(tool_calls, 1):
        name = tc.get("name", "unknown")
        args = tc.get("args", {})
        result = tc.get("result", "")

        _log_summary(f"TOOL {i}: {name}")
        _log_summary(f"  ARGS: {args}")
        _log_summary(f"  RESULT: {result}")
        _log_summary(f"{'-'*40}")

        # For the LLM prompt, truncate long results
        result_for_prompt = result
        if isinstance(result, str) and len(result) > 1000:
            result_for_prompt = result[:1000] + "..."

        tool_details.append(f"- {name}({args}): {result_for_prompt}")

    tool_text = "\n".join(tool_details)

    _log_summary(f"ASSISTANT RESPONSE:")
    _log_summary(assistant_response)
    _log_summary(f"{'-'*80}")

    # Ask Haiku to summarize
    prompt = f"""Summarize this tool call turn in 2-3 sentences. Extract key findings (file paths, function names, line numbers, code patterns).

User question: "{user_message}"

Tools called:
{tool_text}

Assistant response (first 500 chars): "{assistant_response[:500]}..."

Respond in this exact format:
KEY_FINDINGS: [what was found - files, functions, line numbers, code patterns]
ACTION_TAKEN: [what the assistant did with these findings]"""

    _log_summary(f"PROMPT TO HAIKU:")
    _log_summary(prompt)
    _log_summary(f"{'-'*80}")

    try:
        response = llm.invoke([HumanMessage(content=prompt)])
        response_text = response.content.strip()

        _log_summary(f"HAIKU RESPONSE:")
        _log_summary(response_text)

        # Parse the response - handle multi-line format
        key_findings = ""
        action_taken = ""

        # Find KEY_FINDINGS and ACTION_TAKEN sections
        if "KEY_FINDINGS:" in response_text and "ACTION_TAKEN:" in response_text:
            # Extract everything between KEY_FINDINGS: and ACTION_TAKEN:
            key_start = response_text.index("KEY_FINDINGS:") + len("KEY_FINDINGS:")
            action_start = response_text.index("ACTION_TAKEN:")
            key_findings = response_text[key_start:action_start].strip()
            action_taken = response_text[action_start + len("ACTION_TAKEN:"):].strip()
        else:
            # Fallback to line-by-line parsing
            for line in response_text.split("\n"):
                if line.startswith("KEY_FINDINGS:"):
                    key_findings = line.replace("KEY_FINDINGS:", "").strip()
                elif line.startswith("ACTION_TAKEN:"):
                    action_taken = line.replace("ACTION_TAKEN:", "").strip()

        # Clean up multi-line findings to single line for storage
        key_findings = " ".join(key_findings.split())
        action_taken = " ".join(action_taken.split())

        summary = {
            "user_question": user_message,
            "tools_used": [tc.get("name", "unknown") for tc in tool_calls],
            "key_findings": key_findings,
            "assistant_action": action_taken,
        }

        _log_summary(f"GENERATED SUMMARY:")
        _log_summary(f"  key_findings: {key_findings}")
        _log_summary(f"  assistant_action: {action_taken}")
        _log_summary(f"{'='*80}\n")

        return summary

    except Exception as e:
        _log_summary(f"ERROR: {e}")
        _log_summary(f"{'='*80}\n")
        # Return a basic summary on error
        return {
            "user_question": user_message,
            "tools_used": [tc.get("name", "unknown") for tc in tool_calls],
            "key_findings": f"Used {len(tool_calls)} tool(s)",
            "assistant_action": "Responded to user",
        }


def format_summaries_for_context(summaries: list[ToolCallSummary]) -> str:
    """
    Format a list of summaries for inclusion in the classifier/agent context.

    Args:
        summaries: List of ToolCallSummary objects

    Returns:
        Formatted string for context
    """
    if not summaries:
        return ""

    lines = ["Recent tool call history:"]

    for i, summary in enumerate(summaries[-5:], 1):  # Keep last 5
        lines.append(f"\n{i}. User asked: \"{summary['user_question']}\"")
        lines.append(f"   Tools: {', '.join(summary['tools_used'])}")
        lines.append(f"   Found: {summary['key_findings']}")
        lines.append(f"   Action: {summary['assistant_action']}")

    return "\n".join(lines)
