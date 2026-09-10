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
    # Group 31: the administrative role as a row rather than a token claim, and the accessor
    # rewritten to read it.
    "0011_administrative_role_state",
    # Task 34.17: user-owned weather watches, under the same forced owner-only policy as every
    # other user-owned table. Additive — it adds a table and touches none.
    "0012_weather_watches",
    # Repairs the grant 0012 made to the login role instead of the assumed one. A revision of its
    # own rather than an edit, because 0012 was already applied where it matters.
    "0013_weather_watch_grant_repair",
)

# The two roles migrations may name, and what each is for. `0002` creates the assumed role and
# grants it every table privilege the request path needs; `0003` creates the login role and grants
# it none, because the role switch is what grants access.
ASSUMED_ROLE = "weathra_request"
LOGIN_ROLE = "weathra_api"


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


def test_no_revision_grants_a_table_privilege_to_the_login_role() -> None:
    """The invariant `0012` broke, asserted where it costs no database to check.

    `0012` granted ``weather_watches`` to ``weathra_api`` — the role ``DATABASE_URL`` authenticates
    as — rather than to ``weathra_request``, the role a request assumes. The request path then could
    not read the table at all, and the login role could reach it without switching. Both were caught
    downstream, by a permission error in one suite and a privilege count in another; neither names
    the cause. This does.

    ``REVOKE`` mentions of the login role are exactly what a repair looks like, so only ``GRANT`` is
    read. `0003` is exempt: creating the role is its whole purpose, and it grants it nothing.
    """
    offenders: dict[str, list[str]] = {}
    for script in _scripts().walk_revisions():
        source = Path(script.path).read_text(encoding="utf-8")
        granting = [
            line.strip()
            for line in source.splitlines()
            if "GRANT" in line and LOGIN_ROLE in line and "REVOKE" not in line
        ]
        if granting:
            offenders[script.revision] = granting

    assert offenders == {}, (
        f"a revision grants {LOGIN_ROLE} a privilege directly: {offenders}. Grants belong to "
        f"{ASSUMED_ROLE}; the role switch is what puts a request under the policies."
    )


def test_every_revision_id_fits_the_version_column() -> None:
    """Alembic's own ``alembic_version.version_num`` is ``varchar(32)``, created by whichever
    revision ran first and never widened. A longer id applies its DDL and then fails on the
    bookkeeping ``UPDATE``, which on a deployment means a half-described database and a red release.

    Thirty-two is not a guideline here; it is the column.
    """
    too_long = {
        script.revision: len(script.revision)
        for script in _scripts().walk_revisions()
        if len(script.revision) > 32
    }
    assert too_long == {}, f"revision ids longer than alembic_version.version_num: {too_long}"
