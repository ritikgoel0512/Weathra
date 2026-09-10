"""What the signed-in person may consume, and what they have consumed. Protected.

One route. It answers the question a person actually has — *how many questions do I have left, and
when do I get more* — and it answers it for the token subject and nobody else.

**There is no user-id parameter, and that is the design rather than an omission.** A route that
took one would need an authorization check, and an authorization check is a thing that can be
written wrong. The subject comes from the validated token, so a caller who supplies somebody else's
id in a query string, a body, or a header is answered about themselves — not refused, because there
is nothing here to refuse: the identifier was never read.

**What it deliberately does not return.** No internal, lab or evaluation usage: an administrator
reading this route reads the internal allowance because that is genuinely what their traffic counts
against, and an ordinary caller can no more see internal rows here than they can in the database.
No estimated cost — the caller's plan states what they may use, and a currency figure on a screen
that has no billing behind it reads as an amount owed (``specs/usage-limits`` forbids exactly that).
No other subject's anything, by the same argument as the missing parameter.

**Unlimited is reported as unlimited.** A dimension the plan leaves unset comes back with a null
allowance and a null remaining, rather than being omitted or filled in with a large number. A
client can then say "unlimited" instead of guessing whether the field went missing.
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from weathra.api.dependencies import CurrentSession, Inference, Quota
from weathra.api.middleware import annotate
from weathra.auth.deps import IsAdministrative, RequiredPrincipal
from weathra.auth.profiles import ensure_profile
from weathra.entitlements.plans import PlanStore
from weathra.entitlements.quotas import QuotaSubject, UsageReport
from weathra.entitlements.resolver import DEFAULT_PLAN

__all__ = ["router"]

logger = logging.getLogger("weathra.api.usage")

router = APIRouter(tags=["account"])

# How far back the summary looks. Bounded because ``specs/http-api`` asks for a *bounded* recent
# summary, and because an unbounded one would grow into a slow query on the busiest accounts.
SUMMARY_DAYS = 30


class DimensionView(BaseModel):
    """One allowance dimension as the caller sees it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    dimension: str = Field(description="The allowance dimension, such as 'requests_per_day'.")
    window: str = Field(description="The period it is counted over: 'day', 'month', 'concurrent'.")
    allowance: int | None = Field(
        default=None, description="What the plan permits. Null means this plan does not limit it."
    )
    consumed: int = Field(ge=0, description="What has been used in the current window.")
    remaining: int | None = Field(
        default=None, ge=0, description="What is left. Null where the dimension is unlimited."
    )
    resets_at: datetime | None = Field(
        default=None,
        description="When the window turns over. Null for concurrency, which has no boundary — "
        "it falls as soon as a run finishes.",
    )


class RecentUsage(BaseModel):
    """A bounded look back over the caller's own calls. Counts, never content and never cost."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    days: int = Field(ge=1, description="How far back this summary looks.")
    calls: int = Field(ge=0, description="Language model calls, counting each retry separately.")
    failures: int = Field(ge=0, description="How many of them failed.")
    total_tokens: int | None = Field(
        default=None,
        description="Tokens across those calls, or null where the gateway reported none. Null is "
        "not zero: zero would claim the calls used nothing.",
    )


class UsageResponse(BaseModel):
    """The caller's plan, their standing in every dimension, and a bounded recent summary."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    user_id: str = Field(description="The token subject. Never a value the request supplied.")
    plan_code: str = Field(description="The plan in effect, from backend state.")
    plan_name: str = Field(description="Its display name.")
    internal: bool = Field(
        default=False,
        description="Whether this caller's traffic is accounted against the internal allowance "
        "rather than a product plan, which is the case for an administrative principal.",
    )
    dimensions: tuple[DimensionView, ...] = Field(
        description="Every dimension, unlimited ones too."
    )
    recent: RecentUsage


def _views(report: UsageReport) -> tuple[DimensionView, ...]:
    return tuple(
        DimensionView(
            dimension=item.dimension.value,
            window=item.window.value,
            allowance=item.allowance,
            consumed=item.consumed,
            remaining=item.remaining,
            resets_at=item.resets_at,
        )
        for item in report.dimensions
    )


@router.get("/me/usage", response_model=UsageResponse, summary="Your plan and your usage")
async def read_usage(
    request: Request,
    principal: RequiredPrincipal,
    session: CurrentSession,
    inference: Inference,
    quota: Quota,
    administrative: IsAdministrative,
) -> UsageResponse:
    """Your plan, what you have used, and when each window resets.

    The recent summary is read under your own session, so Row Level Security is what scopes it: the
    owner policy on ``llm_usage_events`` returns your rows and nothing else, whatever this query
    says. That is the second gate behind the missing user-id parameter.
    """
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)

    plan_code = await inference.effective_plan(principal, session)
    plan = await PlanStore(session).require(plan_code)
    subject = QuotaSubject.for_principal(principal, plan_code, administrative=administrative)
    report = await quota.report(subject)

    row = (
        await session.execute(
            text(
                "SELECT count(*) AS calls, "
                "       count(*) FILTER (WHERE status = 'failure') AS failures, "
                "       sum(total_tokens) AS tokens "
                "  FROM llm_usage_events "
                " WHERE created_at >= now() - make_interval(days => :days)"
            ),
            {"days": SUMMARY_DAYS},
        )
    ).first()
    calls, failures, tokens = (int(row[0]), int(row[1]), row[2]) if row else (0, 0, None)

    return UsageResponse(
        user_id=principal.user_id,
        plan_code=plan.plan_code.value,
        plan_name=plan.display_name,
        internal=subject.is_internal,
        dimensions=_views(report),
        recent=RecentUsage(
            days=SUMMARY_DAYS,
            calls=calls,
            failures=failures,
            total_tokens=int(tokens) if tokens is not None else None,
        ),
    )


# =========================================================================== the tiers on offer


class PlanAllowanceView(BaseModel):
    """One allowance, as a customer reads it rather than as the limiter stores it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    dimension: str
    window: str
    allowance: int | None = Field(
        default=None, description="Null is unlimited. A dimension with no row is not capped."
    )


class PlanOfferView(BaseModel):
    """A tier, its standing, and what it allows."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    plan_code: str
    display_name: str
    rank: int = Field(description="Ascending entitlement. Free is the lowest.")
    allowances: tuple[PlanAllowanceView, ...]


class PlansResponse(BaseModel):
    """The tiers Weathra offers, and how somebody moves between them.

    ``self_service`` is the field that keeps this page honest. Weathra bills nobody: there is no
    payment integration, no checkout and no self-service upgrade, and a tier above Free is an
    administrative assignment. A pricing surface that offered a Buy button would be describing a
    commercial relationship this product does not have.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    plans: tuple[PlanOfferView, ...]
    default_plan: str = Field(description="What a new account is on before anybody assigns a tier.")
    self_service: bool = Field(
        default=False,
        description="Whether a caller can move themselves between tiers. False: no payment exists.",
    )
    assignment_note: str


ASSIGNMENT_NOTE = (
    "Free is what every new account is on. Pro and Premium are assigned by Weathra rather than "
    "bought here — there is no payment integration in this product — so choosing one records "
    "nothing and charges nothing."
)


@router.get("/plans", response_model=PlansResponse, summary="The subscription tiers")
async def list_offered_plans(request: Request, session: CurrentSession) -> PlansResponse:
    """What the tiers are and what each allows. Public, because it is a pricing question.

    Nothing here is per-caller: no subject is read and no usage is counted, so it answers the same
    way signed in or not. The caller's *own* standing is `/me/usage`, which is protected.
    """
    annotate(request)
    store = PlanStore(session)
    plans = await store.list()
    allowances = await store.allowances()

    by_plan: dict[str, list[PlanAllowanceView]] = {}
    for record in allowances:
        if record.plan_code is None:
            continue  # An internal-subject allowance is not a customer tier's business.
        by_plan.setdefault(str(record.plan_code), []).append(
            PlanAllowanceView(
                dimension=record.dimension.value,
                window=record.window_kind.value,
                allowance=record.allowance,
            )
        )

    return PlansResponse(
        count=len(plans),
        plans=tuple(
            PlanOfferView(
                plan_code=str(plan.plan_code),
                display_name=plan.display_name,
                rank=plan.rank,
                allowances=tuple(by_plan.get(str(plan.plan_code), ())),
            )
            for plan in sorted(plans, key=lambda plan: plan.rank)
        ),
        default_plan=str(DEFAULT_PLAN),
        self_service=False,
        assignment_note=ASSIGNMENT_NOTE,
    )
