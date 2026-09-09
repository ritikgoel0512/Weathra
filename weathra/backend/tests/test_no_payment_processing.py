"""Task 26.2's negative requirement — `specs/usage-limits`: no payment processing in this change.

A requirement that something does *not* exist is easy to satisfy today and easy to breach quietly
later, which is exactly the kind that needs a test rather than a promise. Plans are administratively
assigned rows; estimated cost is an operational figure labelled as an estimate; nothing here takes
money, and nothing should start to without somebody deleting this file on purpose.

The room the spec asks to be left for a later integration is asserted alongside, because "no
billing yet" and "no way to add billing without a migration" are different outcomes and only the
first is wanted: `subscription_plans` carries a stable plan code and an external subscription
reference that stays null, and no behaviour depends on either being populated.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = BACKEND_ROOT / "weathra"

# Distributions that would mean money is being moved, or is about to be.
FORBIDDEN_DISTRIBUTIONS = frozenset(
    {
        "stripe",
        "braintree",
        "paddle",
        "paypalrestsdk",
        "paypalhttp",
        "square",
        "squareup",
        "lemonsqueezy",
        "chargebee",
        "recurly",
        "adyen",
        "razorpay",
    }
)

# Symbols that only appear where checkout, card handling, invoicing or dunning is being built.
# Deliberately narrow: "price" and "cost" are legitimate everywhere, because the catalog holds
# prices and telemetry estimates cost. What is forbidden is *charging*.
FORBIDDEN_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bstripe\b", re.IGNORECASE),
    re.compile(r"\bcheckout[_ ]?session\b", re.IGNORECASE),
    re.compile(r"\bpayment[_ ]?(intent|method|provider)\b", re.IGNORECASE),
    re.compile(r"\bcard[_ ]?(number|token|holder)\b", re.IGNORECASE),
    re.compile(r"\bcvv\b", re.IGNORECASE),
    re.compile(r"\b(invoice|dunning|proration|charge)_", re.IGNORECASE),
    re.compile(r"\bamount_(due|owed|charged)\b", re.IGNORECASE),
)


def _python_files() -> list[Path]:
    return sorted(path for path in PACKAGE_ROOT.rglob("*.py") if "__pycache__" not in path.parts)


def test_no_payment_provider_is_a_dependency() -> None:
    declared = tomllib.loads((BACKEND_ROOT / "pyproject.toml").read_text())
    requirements = declared["project"].get("dependencies", []) + [
        entry
        for group in declared["project"].get("optional-dependencies", {}).values()
        for entry in group
    ]
    names = {re.split(r"[<>=!~\[ ]", entry.strip())[0].lower() for entry in requirements}
    assert not names & FORBIDDEN_DISTRIBUTIONS, (
        f"a payment provider is a declared dependency: {sorted(names & FORBIDDEN_DISTRIBUTIONS)}"
    )


@pytest.mark.parametrize("pattern", FORBIDDEN_PATTERNS, ids=lambda p: p.pattern)
def test_no_checkout_or_card_handling_exists_in_the_source(pattern: re.Pattern[str]) -> None:
    offenders = [
        f"{path.relative_to(PACKAGE_ROOT)}:{index}"
        for path in _python_files()
        for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if pattern.search(line)
    ]
    assert not offenders, f"{pattern.pattern} appears in {offenders}"


def test_the_detector_would_catch_a_checkout_being_added() -> None:
    """A scanner nobody has watched fire is a green light, not a check."""
    sample = "session = stripe.checkout_session.create(amount_due=500, card_number=card)"
    caught = [pattern.pattern for pattern in FORBIDDEN_PATTERNS if pattern.search(sample)]
    assert len(caught) >= 3, f"the patterns missed an obvious checkout: caught only {caught}"


def test_the_plan_model_leaves_room_for_a_later_billing_integration() -> None:
    """`specs/usage-limits`: a stable plan code and an unused external subscription reference.

    Asserted against the model rather than a migration, because the column existing is the point
    and its nullability is what "stays null" needs in order to remain true.
    """
    from weathra.db.models import SubscriptionPlan

    columns = SubscriptionPlan.__table__.columns
    assert "external_subscription_ref" in columns
    assert columns["external_subscription_ref"].nullable, (
        "the reference must be nullable; nothing populates it in this change"
    )
    assert "plan_code" in columns
    assert columns["plan_code"].primary_key, (
        "the plan code is the stable identifier an external product would map to, so it is the key"
    )


def test_estimated_cost_is_never_modelled_as_an_amount_owed() -> None:
    """Cost is an operational estimate. A column or field naming it a charge would be the first
    step towards presenting it as one."""
    from weathra.db.models import LlmUsageEvent

    names = set(LlmUsageEvent.__table__.columns.keys())
    assert "estimated_cost" in names
    for forbidden in ("amount_due", "amount_owed", "charge", "invoice_id", "billed_amount"):
        assert forbidden not in names, f"llm_usage_events carries {forbidden}"
