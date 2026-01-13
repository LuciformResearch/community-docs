"""
LangChain tools for Lucie Agent.

These tools call the community-docs API to search knowledge,
get code samples, and manage conversation memory.
"""

import httpx
from typing import Optional
from langchain_core.tools import tool
from datetime import datetime
from pathlib import Path

from .config import settings


# HTTP client for API calls
_client: httpx.AsyncClient | None = None

# Log file path
LOG_FILE = Path(__file__).parent / "tools.log"


def _write_log(message: str):
    """Write message to both stdout and log file."""
    print(message)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(message + "\n")


def log_tool_call(tool_name: str, args: dict):
    """Log a tool call with timestamp and arguments."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    _write_log(f"\n{'='*60}")
    _write_log(f"[{timestamp}] 🔧 TOOL CALL: {tool_name}")
    _write_log(f"{'='*60}")
    for key, value in args.items():
        _write_log(f"  {key}: {value}")
    _write_log("")


def log_tool_result(tool_name: str, success: bool, result: str):
    """Log the result of a tool call."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    status = "✅ SUCCESS" if success else "❌ ERROR"
    _write_log(f"\n{'-'*60}")
    _write_log(f"[{timestamp}] {status}: {tool_name}")
    _write_log(f"{'-'*60}")
    _write_log(result)
    _write_log(f"{'='*60}\n")


def get_client() -> httpx.AsyncClient:
    """Get or create the HTTP client."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=settings.community_docs_api,
            timeout=30.0
        )
    return _client


@tool
async def search_knowledge(
    query: str,
    limit: int = 5,
    explore_depth: int = 1,
    code_only: bool = True
) -> str:
    """
    Search through Lucie's indexed projects (RagForge, CodeParsers, Community-Docs).

    Use this tool to find relevant code, documentation, or explanations
    from the projects. The search uses semantic similarity to find
    conceptually related content.

    Args:
        query: What to search for (e.g., "hybrid search implementation", "tree-sitter parser")
        limit: Maximum number of results to return (default: 5)
        explore_depth: Depth of relationship exploration (0-2, default: 1)
        code_only: If True, only search code files (default: True). Set to False to include docs.

    Returns:
        Formatted search results in markdown with code snippets and relationships.
    """
    log_tool_call("search_knowledge", {"query": query, "limit": limit, "explore_depth": explore_depth, "code_only": code_only})
    client = get_client()

    # Build search params
    search_params = {
        "query": query,
        "limit": limit,
        "semantic": True,
        "hybrid": True,
        "format": "markdown",
        "includeSource": True,
        "maxSourceResults": 3,
        "exploreDepth": explore_depth,
        "minScore": 0.3,
    }

    # Use server-side glob filtering for code files
    if code_only:
        search_params["glob"] = "**/*.{ts,tsx,js,jsx,py,rs,go,c,cpp,h,hpp,cs,vue,svelte}"

    try:
        response = await client.post(
            "/search",
            json=search_params
        )
        response.raise_for_status()
        data = response.json()

        if not data.get("success"):
            error_msg = f"Search failed: {data.get('error', 'Unknown error')}"
            log_tool_result("search_knowledge", False, error_msg)
            return error_msg

        # Return formatted markdown output from API
        formatted_output = data.get("formattedOutput", "")
        if not formatted_output:
            formatted_output = f"No results found for: {query}"

        log_tool_result("search_knowledge", True, formatted_output)
        return formatted_output

    except httpx.HTTPError as e:
        error_msg = f"HTTP error during search: {str(e)}"
        log_tool_result("search_knowledge", False, error_msg)
        return error_msg
    except Exception as e:
        error_msg = f"Error during search: {str(e)}"
        log_tool_result("search_knowledge", False, error_msg)
        return error_msg


@tool
async def grep_code(
    pattern: str,
    glob: str = "**/*.{ts,tsx,js,jsx,py,rs,go,c,cpp,h,hpp,cs}",
    ignore_case: bool = False,
    context_lines: int = 2,
    limit: int = 20
) -> str:
    """
    Search for a regex pattern across all indexed code files.

    Use this to find exact text patterns, function names, variable usages,
    error messages, or any specific code pattern. Results include line numbers
    and surrounding context.

    Args:
        pattern: Regex pattern to search for (e.g., "async def.*search", "TODO|FIXME")
        glob: File pattern filter (default: common code files). Use "**/*" for all files.
        ignore_case: Case-insensitive matching (default: False)
        context_lines: Lines of context before/after each match (default: 2)
        limit: Maximum number of results (default: 20)

    Returns:
        Formatted grep results with file paths, line numbers, and matching lines.
    """
    log_tool_call("grep_code", {
        "pattern": pattern,
        "glob": glob,
        "ignore_case": ignore_case,
        "context_lines": context_lines,
        "limit": limit
    })
    client = get_client()

    try:
        response = await client.post(
            "/grep",
            json={
                "pattern": pattern,
                "glob": glob,
                "ignoreCase": ignore_case,
                "contextLines": context_lines,
                "limit": limit
            }
        )
        response.raise_for_status()
        data = response.json()

        if not data.get("success"):
            error_msg = f"Grep failed: {data.get('error', 'Unknown error')}"
            log_tool_result("grep_code", False, error_msg)
            return error_msg

        results = data.get("results", [])
        total_matches = data.get("totalMatches", 0)

        if not results:
            result_msg = f"No matches found for pattern: {pattern}"
            log_tool_result("grep_code", True, result_msg)
            return result_msg

        # Format results as markdown
        output_lines = [f"## Found {total_matches} matches for `{pattern}`\n"]

        for result in results:
            file_path = result.get("file", "unknown")
            node_name = result.get("nodeName", "")
            node_type = result.get("nodeType", "")
            matches = result.get("matches", [])

            # File header
            header = f"### `{file_path}`"
            if node_name:
                header += f" - {node_type} `{node_name}`"
            output_lines.append(header)
            output_lines.append("")

            # Each match
            for match in matches:
                line_num = match.get("line", 0)
                content = match.get("content", "").rstrip()
                context_before = match.get("contextBefore", [])
                context_after = match.get("contextAfter", [])

                # Context before
                for i, ctx_line in enumerate(context_before):
                    ctx_num = line_num - len(context_before) + i
                    output_lines.append(f"  {ctx_num:4d} | {ctx_line.rstrip()}")

                # The matching line (highlighted with arrow)
                output_lines.append(f"> {line_num:4d} | {content}")

                # Context after
                for i, ctx_line in enumerate(context_after):
                    ctx_num = line_num + 1 + i
                    output_lines.append(f"  {ctx_num:4d} | {ctx_line.rstrip()}")

                output_lines.append("")

            output_lines.append("---")
            output_lines.append("")

        result = "\n".join(output_lines)
        log_tool_result("grep_code", True, result)
        return result

    except httpx.HTTPError as e:
        error_msg = f"HTTP error during grep: {str(e)}"
        log_tool_result("grep_code", False, error_msg)
        return error_msg
    except Exception as e:
        error_msg = f"Error during grep: {str(e)}"
        log_tool_result("grep_code", False, error_msg)
        return error_msg


@tool
async def get_code_sample(
    file_path: str,
    line_number: int
) -> str:
    """
    Get the full source code of a scope (function, class, method) at a specific line.

    Use this after search_knowledge to get the complete code of a scope.
    The search results show file paths with line numbers like "agent.py:60-219".
    Use this tool with the file path and any line number within that range.

    Args:
        file_path: Path to the file (e.g., "agents/lucie_agent/agent.py" or full path)
        line_number: A line number within the scope you want to retrieve

    Returns:
        The complete source code of the scope containing that line.
    """
    log_tool_call("get_code_sample", {"file_path": file_path, "line_number": line_number})
    client = get_client()

    try:
        # Find the Scope that contains this line number
        response = await client.post(
            "/cypher",
            json={
                "query": """
                    MATCH (s:Scope)
                    WHERE s.file CONTAINS $filePath
                      AND s.startLine <= $lineNumber
                      AND s.endLine >= $lineNumber
                    RETURN s.name AS name, s.type AS type, s.source AS source,
                           s.startLine AS startLine, s.endLine AS endLine,
                           s.file AS file, s.description AS description
                    ORDER BY (s.endLine - s.startLine) ASC
                    LIMIT 1
                """,
                "params": {
                    "filePath": file_path,
                    "lineNumber": line_number
                }
            }
        )
        response.raise_for_status()
        data = response.json()

        if not data.get("success"):
            error_msg = f"Query failed: {data.get('error', 'Unknown error')}"
            log_tool_result("get_code_sample", False, error_msg)
            return error_msg

        records = data.get("records", [])
        if not records:
            error_msg = f"No scope found at {file_path}:{line_number}"
            log_tool_result("get_code_sample", False, error_msg)
            return error_msg

        record = records[0]
        name = record.get("name", "unknown")
        scope_type = record.get("type", "unknown")
        source = record.get("source", "")
        start_line = record.get("startLine", 0)
        end_line = record.get("endLine", 0)
        file = record.get("file", file_path)
        description = record.get("description", "")

        if not source:
            error_msg = f"Scope found but source is empty: {name} ({scope_type})"
            log_tool_result("get_code_sample", False, error_msg)
            return error_msg

        # Format with line numbers
        lines = source.split("\n")
        formatted_lines = []
        for i, line in enumerate(lines):
            line_num = start_line + i
            formatted_lines.append(f"{line_num:4d} | {line}")

        # Build result
        header = f"**{scope_type}** `{name}` @ `{file}:{start_line}-{end_line}`"
        if description:
            header += f"\n📝 {description}"

        result = f"{header}\n\n```\n" + "\n".join(formatted_lines) + "\n```"
        log_tool_result("get_code_sample", True, result)
        return result

    except httpx.HTTPError as e:
        error_msg = f"HTTP error: {str(e)}"
        log_tool_result("get_code_sample", False, error_msg)
        return error_msg
    except Exception as e:
        error_msg = f"Error: {str(e)}"
        log_tool_result("get_code_sample", False, error_msg)
        return error_msg


# List of all tools for the agent
ALL_TOOLS = [
    search_knowledge,
    grep_code,
    get_code_sample,
]


async def cleanup():
    """Cleanup resources."""
    global _client
    if _client:
        await _client.aclose()
        _client = None
