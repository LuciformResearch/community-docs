"""
LangChain tools for Lucie Agent.

These tools call the community-docs API to search knowledge,
get code samples, and manage conversation memory.
"""

import httpx
from typing import Optional
from langchain_core.tools import tool

from .config import settings


# HTTP client for API calls
_client: httpx.AsyncClient | None = None


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
    explore_depth: int = 1
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

    Returns:
        Formatted search results in markdown with code snippets and relationships.
    """
    client = get_client()

    try:
        response = await client.post(
            "/search",
            json={
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
        )
        response.raise_for_status()
        data = response.json()

        if not data.get("success"):
            return f"Search failed: {data.get('error', 'Unknown error')}"

        # When format is markdown, the response contains a 'formattedOutput' field
        formatted_output = data.get("formattedOutput")
        if formatted_output:
            return formatted_output

        # Fallback if no markdown (shouldn't happen with format: markdown)
        results = data.get("results", [])
        if not results:
            return f"No results found for: {query}"

        return f"Found {len(results)} results for '{query}' (use get_code_sample for details)"

    except httpx.HTTPError as e:
        return f"HTTP error during search: {str(e)}"
    except Exception as e:
        return f"Error during search: {str(e)}"


@tool
async def get_code_sample(
    file_path: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None
) -> str:
    """
    Get a specific code sample from Lucie's projects.

    Use this after search_knowledge to get more context around a specific
    file or code section.

    Args:
        file_path: Relative path to the file (e.g., "packages/ragforge-core/src/runtime/search/hybrid-search.ts")
        start_line: Optional starting line number
        end_line: Optional ending line number

    Returns:
        The code content with line numbers.
    """
    client = get_client()

    # Build the full virtual path
    full_path = f"/virtual/community-docs-self/github.com/LuciformResearch/community-docs/{file_path}"

    try:
        # Use Cypher to find the file node and get content
        response = await client.post(
            "/cypher",
            json={
                "query": """
                    MATCH (f:File)
                    WHERE f.absolutePath = $path OR f.path CONTAINS $shortPath
                    RETURN f.content AS content, f.path AS path
                    LIMIT 1
                """,
                "params": {
                    "path": full_path,
                    "shortPath": file_path
                }
            }
        )
        response.raise_for_status()
        data = response.json()

        if not data.get("success"):
            return f"Query failed: {data.get('error', 'Unknown error')}"

        records = data.get("records", [])
        if not records:
            return f"File not found: {file_path}"

        content = records[0].get("content", "")
        actual_path = records[0].get("path", file_path)

        if not content:
            return f"File found but content is empty: {actual_path}"

        # Apply line filtering if specified
        lines = content.split("\n")

        if start_line is not None and end_line is not None:
            start_idx = max(0, start_line - 1)
            end_idx = min(len(lines), end_line)
            lines = lines[start_idx:end_idx]
            line_offset = start_line
        else:
            line_offset = 1

        # Format with line numbers
        formatted_lines = []
        for i, line in enumerate(lines):
            line_num = line_offset + i
            formatted_lines.append(f"{line_num:4d} | {line}")

        # Truncate if too long
        if len(formatted_lines) > 100:
            formatted_lines = formatted_lines[:100]
            formatted_lines.append("... (truncated)")

        return f"**File:** `{actual_path}`\n```\n" + "\n".join(formatted_lines) + "\n```"

    except httpx.HTTPError as e:
        return f"HTTP error: {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"


@tool
async def recall_memory(
    conversation_id: str,
    limit: int = 10
) -> str:
    """
    Recall previous messages from a conversation.

    Use this to remember what was discussed earlier in the conversation
    or to provide context-aware responses.

    Args:
        conversation_id: The conversation ID to recall from
        limit: Maximum number of messages to retrieve (default: 10)

    Returns:
        Previous messages in the conversation.
    """
    client = get_client()

    try:
        response = await client.post(
            "/cypher",
            json={
                "query": """
                    MATCH (c:LucieConversation {id: $conversationId})-[:HAS_MESSAGE]->(m:LucieMessage)
                    RETURN m.role AS role, m.content AS content, m.timestamp AS timestamp
                    ORDER BY m.timestamp DESC
                    LIMIT toInteger($limit)
                """,
                "params": {
                    "conversationId": conversation_id,
                    "limit": limit
                }
            }
        )
        response.raise_for_status()
        data = response.json()

        if not data.get("success"):
            return f"Query failed: {data.get('error', 'Unknown error')}"

        records = data.get("records", [])
        if not records:
            return "No previous messages found in this conversation."

        # Format messages (reverse to show oldest first)
        output = f"Previous {len(records)} messages:\n\n"
        for record in reversed(records):
            role = record.get("role", "unknown")
            content = record.get("content", "")
            # Truncate long messages
            if len(content) > 200:
                content = content[:200] + "..."
            output += f"**{role}**: {content}\n\n"

        return output

    except httpx.HTTPError as e:
        return f"HTTP error: {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"


# List of all tools for the agent
ALL_TOOLS = [
    search_knowledge,
    get_code_sample,
    recall_memory,
]


async def cleanup():
    """Cleanup resources."""
    global _client
    if _client:
        await _client.aclose()
        _client = None
