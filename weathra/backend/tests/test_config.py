"""Task 1.5 — Settings covers decision 19's table, needs no LLM credential, and refuses the
service-role key on a request-serving path."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from weathra.config import SERVICE_ROLE_ON_REQUEST_PATH_MESSAGE, Settings, get_settings

REQUIRED_ONLY = {"supabase_url": "https://project.supabase.co"}


def settings(**overrides: object) -> Settings:
    return Settings(**{**REQUIRED_ONLY, **overrides})  # type: ignore[arg-type]


def test_constructs_from_only_the_required_variables() -> None:
    assert settings().supabase_url is not None


def test_no_inference_credential_is_required() -> None:
    built = settings()
    assert built.openrouter_api_key is None
    assert built.inference_configured is False


def test_no_database_url_is_required_to_construct() -> None:
    """Analytics, the MCP tools, and the offline test suite construct Settings with no database."""
    assert settings().database_url is None


def test_documented_defaults() -> None:
    built = settings()
    assert built.runtime_mode == "request_serving"
    assert built.log_level == "INFO"
    assert built.api_version_prefix == "/api/v1"
    assert built.cors_allowed_origins == ("http://localhost:3000",)
    # identity
    assert built.supabase_jwt_audience == "authenticated"
    assert built.supabase_jwks_cache_ttl_seconds == 600
    assert built.supabase_jwt_leeway_seconds == 30
    assert built.supabase_service_role_key is None
    # persistence
    assert built.database_pool_size == 5
    assert built.database_restricted_role == "weathra_request"
    # inference
    assert built.llm_provider == "openrouter"
    assert built.llm_timeout_seconds == 60.0
    assert built.llm_max_retries == 2
    assert built.llm_json_max_attempts == 3
    # weather
    assert built.default_weather_provider == "open-meteo"
    assert built.default_unit_system == "metric"
    assert built.default_forecast_days == 7
    assert built.minimum_hourly_hours == 48
    assert built.http_timeout_seconds == 10.0
    assert built.http_max_retries == 2
    # caching — historical entries outlive forecast entries (decision 8)
    assert built.cache_current_ttl_seconds == 900
    assert built.cache_forecast_ttl_seconds == 3_600
    assert built.cache_history_ttl_seconds > built.cache_forecast_ttl_seconds
    # agents
    assert built.agent_max_steps == 24
    assert built.agent_wall_clock_budget_seconds == 120.0
    assert built.comparison_max_locations == 8
    # MCP
    assert built.mcp_transport == "in-process"
    assert len(built.mcp_enabled_tools) == 7
    # RAG
    assert built.embedding_model_id == "BAAI/bge-small-en-v1.5"
    assert built.embedding_dimension == 384
    assert built.rag_top_k == 4
    assert built.vector_store == "pgvector"
    # retention
    assert built.thread_retention_days == 30
    assert built.snapshot_retention_days == 90
    assert built.saved_locations_limit == 25


def test_service_role_key_refused_on_the_request_serving_path() -> None:
    with pytest.raises(ValidationError) as caught:
        settings(supabase_service_role_key="service-role-secret")
    assert SERVICE_ROLE_ON_REQUEST_PATH_MESSAGE in str(caught.value)


def test_service_role_key_permitted_in_privileged_mode() -> None:
    built = settings(runtime_mode="privileged", supabase_service_role_key="service-role-secret")
    assert built.is_privileged is True
    assert built.supabase_service_role_key is not None


def test_secret_values_do_not_render_in_repr() -> None:
    built = settings(
        runtime_mode="privileged",
        supabase_service_role_key="service-role-secret",
        openrouter_api_key="sk-or-secret",
        database_url="postgresql+asyncpg://u:pw@host/db",
    )
    rendered = repr(built) + str(built)
    for secret in ("service-role-secret", "sk-or-secret", "pw@host"):
        assert secret not in rendered


def test_issuer_and_jwks_url_derive_from_the_project_url() -> None:
    built = settings()
    assert built.jwt_issuer == "https://project.supabase.co/auth/v1"
    assert built.jwks_url == "https://project.supabase.co/auth/v1/.well-known/jwks.json"


def test_explicit_issuer_and_jwks_url_win() -> None:
    built = settings(
        supabase_jwt_issuer="https://issuer.example/auth/v1",
        supabase_jwks_url="https://issuer.example/keys",
    )
    assert built.jwt_issuer == "https://issuer.example/auth/v1"
    assert built.jwks_url == "https://issuer.example/keys"


def test_wildcard_cors_origin_refused() -> None:
    with pytest.raises(ValidationError, match="wildcard"):
        settings(cors_allowed_origins="*")


def test_comma_separated_lists_are_parsed() -> None:
    built = settings(cors_allowed_origins="https://a.example, https://b.example")
    assert built.cors_allowed_origins == ("https://a.example", "https://b.example")


def test_missing_project_url_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """The variable is cleared, because "missing" has to actually be missing.

    ``_env_file=None`` only stops pydantic-settings reading the `.env` file; it still reads the
    *process* environment. So this test passed on a developer's machine, where nothing exports
    ``SUPABASE_URL``, and failed in CI, where the workflow sets it at job level so the rest of the
    suite can construct Settings. The environment it asserts about was ambient rather than stated.
    """
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("supabase_url", raising=False)
    with pytest.raises(ValidationError, match="supabase_url"):
        Settings(_env_file=None)


def test_chunk_overlap_must_be_smaller_than_the_chunk() -> None:
    with pytest.raises(ValidationError, match="OVERLAP"):
        settings(rag_chunk_max_tokens=100, rag_chunk_overlap_tokens=100)


def test_get_settings_is_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    """Via ``monkeypatch`` so the variable is removed again afterwards.

    Setting it through ``os.environ`` left ``SUPABASE_URL`` exported for every test that ran after
    this one in the same process — including the one above, which asserts the variable is absent.
    That is the same leak, from the other direction.
    """
    get_settings.cache_clear()
    try:
        monkeypatch.setenv("SUPABASE_URL", "https://cached.supabase.co")
        first = get_settings()
        second = get_settings()
        assert first is second
    finally:
        get_settings.cache_clear()
        import os

        os.environ.pop("SUPABASE_URL", None)
