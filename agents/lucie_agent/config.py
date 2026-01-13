"""
Configuration for Lucie Agent.
"""

from pathlib import Path
from pydantic_settings import BaseSettings
from pydantic import Field

# Get the directory where this config file lives
_CONFIG_DIR = Path(__file__).parent


class Settings(BaseSettings):
    """Agent configuration loaded from environment variables."""

    # API Keys
    anthropic_api_key: str = Field(..., env="ANTHROPIC_API_KEY")

    # Community Docs API
    community_docs_api: str = Field(
        default="http://localhost:6970",
        env="COMMUNITY_DOCS_API"
    )

    # Neo4j (for direct memory access if needed)
    neo4j_uri: str = Field(
        default="bolt://localhost:7688",
        env="NEO4J_URI"
    )
    neo4j_password: str = Field(
        default="ragforge",
        env="NEO4J_PASSWORD"
    )

    # Agent Settings
    model_name: str = Field(
        default="claude-sonnet-4-20250514",
        env="MODEL_NAME"
    )
    fallback_model_name: str = Field(
        default="claude-3-5-haiku-20241022",
        env="FALLBACK_MODEL_NAME",
        description="Fallback model when primary hits rate limits (Haiku has higher limits)"
    )
    max_iterations: int = Field(
        default=10,
        env="MAX_ITERATIONS"
    )
    temperature: float = Field(
        default=0.7,
        env="TEMPERATURE"
    )

    # Server Settings
    host: str = Field(default="0.0.0.0", env="HOST")
    port: int = Field(default=8000, env="PORT")

    # Rate Limiting
    rate_limit_per_minute: int = Field(
        default=10,
        env="RATE_LIMIT_PER_MINUTE"
    )

    class Config:
        env_file = str(_CONFIG_DIR / ".env")
        env_file_encoding = "utf-8"
        extra = "ignore"


# Global settings instance
settings = Settings()
