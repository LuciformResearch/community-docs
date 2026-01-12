"""
Lucie Agent - LangGraph-based conversational agent with RAG capabilities.

This agent represents Lucie Defraiteur and can answer questions about
RagForge, CodeParsers, and Community-Docs projects.
"""

from .agent import create_agent, run_agent
from .config import settings

__version__ = "0.1.0"
__all__ = ["create_agent", "run_agent", "settings"]
