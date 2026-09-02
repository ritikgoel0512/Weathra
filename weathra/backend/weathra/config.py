"""Backend configuration.

Every backend variable in design.md decision 19's table lives here, and nothing else reads the
environment. Two rules are load-bearing:

* The backend must construct and serve every public capability with ``OPENROUTER_API_KEY`` absent.
  No field required to build ``Settings`` is an inference credential.
* ``SUPABASE_SERVICE_ROLE_KEY`` is a privileged credential. It belongs to migrations, the retention
  routine, and evaluation test-user provisioning — never to a process serving browser requests. A
  validator refuses to start when it is present in ``request_serving`` mode.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Literal, Self

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

RuntimeMode = Literal["request_serving", "privileged"]
UnitSystemName = Literal["metric", "imperial"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]

SERVICE_ROLE_ON_REQUEST_PATH_MESSAGE = (
    "SUPABASE_SERVICE_ROLE_KEY must not be set when WEATHRA_RUNTIME_MODE is 'request_serving'. "
    "The service-role key bypasses Row Level Security; a request-serving process uses the "
    "restricted connection (DATABASE_URL) instead. Set WEATHRA_RUNTIME_MODE=privileged only for "
    "migrations, the retention routine, and evaluation test-user provisioning."
)


class Settings(BaseSettings):
    """The full backend configuration surface. Constructed once per process."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        validate_default=True,
        # Fields carry an env alias; tests and callers may also pass the field name directly.
        populate_by_name=True,
    )

    # ---------------------------------------------------------------- runtime

    runtime_mode: RuntimeMode = Field(
        default="request_serving",
        validation_alias="weathra_runtime_mode",
        description=(
            "'request_serving' for the API and stream processes; 'privileged' for migrations, "
            "retention, and evaluation provisioning."
        ),
    )
    environment: str = Field(default="development", validation_alias="weathra_environment")
    log_level: LogLevel = Field(default="INFO", validation_alias="log_level")
    api_version_prefix: str = Field(default="/api/v1", validation_alias="api_version_prefix")
    cors_allowed_origins: tuple[str, ...] = Field(
        default=("http://localhost:3000",),
        validation_alias="cors_allowed_origins",
        description="Explicit frontend origins. A wildcard is refused.",
    )

    # ---------------------------------------------------------------- identity (Supabase Auth)

    supabase_url: AnyHttpUrl = Field(
        validation_alias="supabase_url",
        description="Supabase project URL. Issuer and key-set URLs derive from it when unset.",
    )
    supabase_jwt_issuer: str | None = Field(default=None, validation_alias="supabase_jwt_issuer")
    supabase_jwt_audience: str = Field(
        default="authenticated", validation_alias="supabase_jwt_audience"
    )
    supabase_jwks_url: str | None = Field(default=None, validation_alias="supabase_jwks_url")
    supabase_jwks_cache_ttl_seconds: Annotated[int, Field(ge=30, le=86_400)] = Field(
        default=600, validation_alias="supabase_jwks_cache_ttl"
    )
    supabase_jwt_leeway_seconds: Annotated[int, Field(ge=0, le=300)] = Field(
        default=30,
        validation_alias="supabase_jwt_leeway_seconds",
        description="Clock-skew allowance on expiry and not-before checks.",
    )
    supabase_service_role_key: SecretStr | None = Field(
        default=None,
        validation_alias="supabase_service_role_key",
        description="Privileged credential. Permitted only in 'privileged' runtime mode.",
    )

    # ---------------------------------------------------------------- persistence

    database_url: SecretStr | None = Field(
        default=None,
        validation_alias="database_url",
        description="Request-serving connection, running under the restricted role.",
    )
    database_url_privileged: SecretStr | None = Field(
        default=None,
        validation_alias="database_url_privileged",
        description="Migrations and administrative routines only.",
    )
    database_pool_size: Annotated[int, Field(ge=1, le=50)] = Field(
        default=5,
        validation_alias="database_pool_size",
        description="Deliberately small: Postgres connection limits bind before app throughput.",
    )
    database_pool_max_overflow: Annotated[int, Field(ge=0, le=50)] = Field(
        default=2, validation_alias="database_pool_max_overflow"
    )
    database_restricted_role: str = Field(
        default="weathra_request",
        validation_alias="database_restricted_role",
        description="Role a request-scoped session assumes so RLS policies apply to it.",
    )

    # ---------------------------------------------------------------- inference

    llm_provider: str = Field(default="openrouter", validation_alias="llm_provider")
    llm_model: str = Field(
        default="nvidia/nemotron-nano-9b-v2:free",
        validation_alias="llm_model",
        description="Any gateway model id. Configuration, never architecture.",
    )
    openrouter_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="openrouter_api_key",
        description="Absent by design in every offline path. Only /ask and /stream need it.",
    )
    openrouter_base_url: str = Field(
        default="https://openrouter.ai/api/v1", validation_alias="openrouter_base_url"
    )
    llm_timeout_seconds: Annotated[float, Field(gt=0, le=300)] = Field(
        default=60.0, validation_alias="llm_timeout_seconds"
    )
    llm_max_retries: Annotated[int, Field(ge=0, le=10)] = Field(
        default=2, validation_alias="llm_max_retries"
    )
    llm_json_max_attempts: Annotated[int, Field(ge=1, le=10)] = Field(
        default=3,
        validation_alias="llm_json_max_attempts",
        description="Bounded retries when a JSON plan fails schema validation.",
    )

    # ---------------------------------------------------------------- weather providers

    default_weather_provider: str = Field(
        default="open-meteo", validation_alias="default_weather_provider"
    )
    default_geocoder: str = Field(default="open-meteo", validation_alias="default_geocoder")
    default_unit_system: UnitSystemName = Field(
        default="metric", validation_alias="default_unit_system"
    )
    default_forecast_days: Annotated[int, Field(ge=1, le=16)] = Field(
        default=7, validation_alias="default_forecast_days"
    )
    minimum_hourly_hours: Annotated[int, Field(ge=1, le=384)] = Field(
        default=48,
        validation_alias="minimum_hourly_hours",
        description="Hourly detail guaranteed for at least this far into the horizon.",
    )
    http_timeout_seconds: Annotated[float, Field(gt=0, le=120)] = Field(
        default=10.0, validation_alias="http_timeout_seconds"
    )
    http_connect_timeout_seconds: Annotated[float, Field(gt=0, le=60)] = Field(
        default=5.0, validation_alias="http_connect_timeout_seconds"
    )
    http_max_retries: Annotated[int, Field(ge=0, le=10)] = Field(
        default=2, validation_alias="http_max_retries"
    )
    http_backoff_seconds: Annotated[float, Field(ge=0, le=30)] = Field(
        default=0.25, validation_alias="http_backoff_seconds"
    )

    # ---------------------------------------------------------------- caching

    cache_current_ttl_seconds: Annotated[int, Field(ge=0, le=86_400)] = Field(
        default=900, validation_alias="cache_current_ttl_seconds"
    )
    cache_forecast_ttl_seconds: Annotated[int, Field(ge=0, le=86_400)] = Field(
        default=3_600, validation_alias="cache_forecast_ttl_seconds"
    )
    cache_history_ttl_seconds: Annotated[int, Field(ge=0, le=2_592_000)] = Field(
        default=604_800,
        validation_alias="cache_history_ttl_seconds",
        description="Past weather does not change, so historical entries outlive forecast ones.",
    )
    cache_geocoding_ttl_seconds: Annotated[int, Field(ge=0, le=2_592_000)] = Field(
        default=604_800, validation_alias="cache_geocoding_ttl_seconds"
    )
    cache_max_entries: Annotated[int, Field(ge=1, le=100_000)] = Field(
        default=2_048, validation_alias="cache_max_entries"
    )

    # ---------------------------------------------------------------- agents

    agent_max_steps: Annotated[int, Field(ge=1, le=200)] = Field(
        default=24, validation_alias="agent_max_steps"
    )
    agent_wall_clock_budget_seconds: Annotated[float, Field(gt=0, le=3_600)] = Field(
        default=120.0,
        validation_alias="agent_wall_clock_budget_seconds",
        description="Set below the access-token lifetime so a stream cannot outlive its token.",
    )
    comparison_max_locations: Annotated[int, Field(ge=2, le=25)] = Field(
        default=8, validation_alias="comparison_max_locations"
    )

    # ---------------------------------------------------------------- MCP

    mcp_transport: Literal["in-process", "http"] = Field(
        default="in-process", validation_alias="mcp_transport"
    )
    mcp_server_address: str = Field(
        default="http://127.0.0.1:8000/mcp", validation_alias="mcp_server_address"
    )
    mcp_timeout_seconds: Annotated[float, Field(gt=0, le=300)] = Field(
        default=30.0, validation_alias="mcp_timeout_seconds"
    )
    mcp_enabled_tools: tuple[str, ...] = Field(
        default=(
            "geocode_location",
            "weather_current",
            "weather_forecast",
            "weather_history",
            "weather_compare",
            "weather_statistics",
            "weather_anomaly",
        ),
        validation_alias="mcp_enabled_tools",
    )

    # ---------------------------------------------------------------- RAG

    embedding_model_id: str = Field(
        default="BAAI/bge-small-en-v1.5", validation_alias="embedding_model_id"
    )
    embedding_dimension: Annotated[int, Field(ge=1, le=4_096)] = Field(
        default=384, validation_alias="embedding_dimension"
    )
    rag_top_k: Annotated[int, Field(ge=1, le=50)] = Field(default=4, validation_alias="rag_top_k")
    rag_relevance_threshold: Annotated[float, Field(ge=0.0, le=1.0)] = Field(
        default=0.35,
        validation_alias="rag_relevance_threshold",
        description="Minimum cosine similarity. Below it, nothing is returned at all.",
    )
    rag_chunk_max_tokens: Annotated[int, Field(ge=32, le=2_048)] = Field(
        default=320, validation_alias="rag_chunk_max_tokens"
    )
    rag_chunk_overlap_tokens: Annotated[int, Field(ge=0, le=512)] = Field(
        default=48, validation_alias="rag_chunk_overlap_tokens"
    )
    vector_store: Literal["pgvector"] = Field(default="pgvector", validation_alias="vector_store")

    # ---------------------------------------------------------------- memory and retention

    thread_retention_days: Annotated[int, Field(ge=1, le=3_650)] = Field(
        default=30, validation_alias="thread_retention_days"
    )
    snapshot_retention_days: Annotated[int, Field(ge=1, le=3_650)] = Field(
        default=90, validation_alias="snapshot_retention_days"
    )
    saved_locations_limit: Annotated[int, Field(ge=1, le=500)] = Field(
        default=25, validation_alias="saved_locations_limit"
    )

    # ---------------------------------------------------------------- validators

    @field_validator("cors_allowed_origins", "mcp_enabled_tools", mode="before")
    @classmethod
    def _split_comma_separated(cls, value: object) -> object:
        if isinstance(value, str):
            return tuple(part.strip() for part in value.split(",") if part.strip())
        return value

    @field_validator("cors_allowed_origins")
    @classmethod
    def _refuse_wildcard_origin(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if any(origin == "*" for origin in value):
            raise ValueError(
                "CORS_ALLOWED_ORIGINS must list explicit origins; a wildcard is not permitted."
            )
        if not value:
            raise ValueError("CORS_ALLOWED_ORIGINS must name at least one origin.")
        return value

    @field_validator("api_version_prefix")
    @classmethod
    def _normalize_prefix(cls, value: str) -> str:
        if not value.startswith("/"):
            raise ValueError("API_VERSION_PREFIX must start with '/'.")
        return value.rstrip("/")

    @model_validator(mode="after")
    def _refuse_service_role_key_on_request_path(self) -> Self:
        if self.runtime_mode == "request_serving" and self.supabase_service_role_key is not None:
            raise ValueError(SERVICE_ROLE_ON_REQUEST_PATH_MESSAGE)
        return self

    @model_validator(mode="after")
    def _refuse_overlapping_chunk_bounds(self) -> Self:
        if self.rag_chunk_overlap_tokens >= self.rag_chunk_max_tokens:
            raise ValueError("RAG_CHUNK_OVERLAP_TOKENS must be smaller than RAG_CHUNK_MAX_TOKENS.")
        return self

    # ---------------------------------------------------------------- derived values

    @property
    def jwt_issuer(self) -> str:
        """The expected token issuer, derived from the project URL when not set explicitly."""
        if self.supabase_jwt_issuer:
            return self.supabase_jwt_issuer
        return f"{str(self.supabase_url).rstrip('/')}/auth/v1"

    @property
    def jwks_url(self) -> str:
        """The published signing-key endpoint, derived from the project URL when not set."""
        if self.supabase_jwks_url:
            return self.supabase_jwks_url
        return f"{str(self.supabase_url).rstrip('/')}/auth/v1/.well-known/jwks.json"

    @property
    def inference_configured(self) -> bool:
        """False is a supported state: every non-agent capability serves without a credential."""
        return self.openrouter_api_key is not None

    @property
    def is_privileged(self) -> bool:
        return self.runtime_mode == "privileged"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings. Cached so the environment is read exactly once."""
    return Settings()  # values come from the environment
