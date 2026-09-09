"""The revision graph, checked without a database.

Alembic will happily accept two heads and then refuse to upgrade, and a mistyped ``down_revision``
produces a chain that applies in the wrong order or not at all. Neither shows up until something
runs the migrations, which for a deployment is the worst possible moment.
"""

from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

BACKEND_ROOT = Path(__file__).resolve().parents[2]

# The order the migrations must apply in, which is also the order they are written to be read in:
# schema, then the policies that constrain it, then the identity that is subject to them, then the
# policies the platform's own defaults made necessary.
EXPECTED_CHAIN = (
    "0001_initial_schema",
    "0002_row_level_security",
    "0003_request_login_role",
    "0004_shared_read_policies",
    # The SaaS-ready layer of group 26, in the order its dependencies require: the operational
    # tables the rest reference, the user-owned tables whose foreign keys point at them, the lab
    # and audit tables, and only then the data, which needs every one of those to exist.
    "0005_saas_operational_tables",
    "0006_saas_user_owned_tables",
    "0007_model_lab_and_audit_tables",
    "0008_seed_model_policy_data",
    # Group 29: the one grant account deletion needs, once telemetry gave the request path rows to
    # delete. Separate from 0006 because it is a change of mind about privilege, not a table.
    "0009_usage_counter_delete_grant",
    # Group 30: the administrative-role accessor, and the second policy on `usage_counters` that
    # lets an administrator's product-path call be accounted against the internal allowance.
    "0010_internal_quota_accounting",
)


def _scripts() -> ScriptDirectory:
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "weathra" / "db" / "migrations"))
    return ScriptDirectory.from_config(config)


def test_there_is_exactly_one_head() -> None:
    """Two heads mean `alembic upgrade head` fails outright, and the failure names neither."""
    assert _scripts().get_heads() == [EXPECTED_CHAIN[-1]]


def test_the_chain_applies_in_the_intended_order() -> None:
    scripts = _scripts()
    walked = tuple(script.revision for script in scripts.walk_revisions())
    assert walked == tuple(reversed(EXPECTED_CHAIN))


def test_every_revision_has_a_downgrade() -> None:
    """CI verifies `alembic downgrade base` on every run; a revision that cannot be undone would
    break that gate for every later migration, not only its own."""
    for script in _scripts().walk_revisions():
        source = Path(script.path).read_text(encoding="utf-8")
        assert "def downgrade()" in source, f"{script.revision} defines no downgrade"
