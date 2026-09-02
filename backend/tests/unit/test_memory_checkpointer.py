"""Task 12.1 — what the checkpointer does with no store behind it.

These need no database, which is the point: honest degradation has to be assertable without
arranging an outage (``specs/memory``).
"""

from __future__ import annotations

import pytest

from weathra.config import Settings
from weathra.domain.errors import MemoryUnavailable
from weathra.memory.checkpointer import Checkpointer

# 127.0.0.1 on a port nothing listens on: refused immediately, no network, no waiting.
UNREACHABLE = "postgresql://weathra:weathra@127.0.0.1:1/weathra"


def _settings(url: str) -> Settings:
    return Settings(supabase_url="https://test.supabase.co", database_url=url)


async def test_an_unreachable_store_reports_unavailability_rather_than_raising_a_driver_error() -> (
    None
):
    checkpointer = Checkpointer(_settings(UNREACHABLE))
    with pytest.raises(MemoryUnavailable) as raised:
        await checkpointer.open(connect_timeout=1.0)
    assert raised.value.code == "memory_unavailable"
    assert "127.0.0.1" not in str(raised.value), "the connection string must not reach the message"


async def test_a_closed_checkpointer_refuses_to_hand_out_a_saver() -> None:
    """A graph compiled with no checkpointer would run and silently forget."""
    checkpointer = Checkpointer(_settings(UNREACHABLE))
    assert not checkpointer.is_open
    with pytest.raises(MemoryUnavailable):
        _ = checkpointer.saver


async def test_closing_a_checkpointer_that_never_opened_is_not_an_error() -> None:
    await Checkpointer(_settings(UNREACHABLE)).close()


async def test_no_configured_request_url_is_a_configuration_error_not_an_outage() -> None:
    """Distinguishable on purpose: one is fixed by an operator, the other by waiting."""
    checkpointer = Checkpointer(Settings(supabase_url="https://test.supabase.co"))
    with pytest.raises(ValueError, match="DATABASE_URL is not configured"):
        await checkpointer.open(connect_timeout=1.0)
