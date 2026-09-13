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
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.api.dependencies import CurrentSession, Inference, Quota
from weathra.api.middleware import annotate
from weathra.auth.deps import IsAdministrative, RequiredPrincipal
from weathra.auth.profiles import ensure_profile
from weathra.domain.entitlements import CallRole, PlanCode
from weathra.domain.identity import Principal
from weathra.entitlements.catalog import CatalogStore
from weathra.entitlements.plans import PlanStore
from weathra.entitlements.policies import PolicyStore
from weathra.entitlements.quotas import QuotaSubject, UsageReport
from weathra.entitlements.records import CatalogStatus, PlanRecord
from weathra.entitlements.resolver import DEFAULT_PLAN
from weathra.telemetry.aggregate import UsageWindow, aggregate_usage_series

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


class UsageDay(BaseModel):
    """One day of the caller's own usage. The shape a trend is drawn from."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    date: str = Field(description="The day this point covers, as an ISO date in UTC.")
    calls: int = Field(ge=0)
    failures: int = Field(ge=0)
    total_tokens: int | None = Field(
        default=None, description="Tokens that day, or null where no gateway reported any."
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
    series: tuple[UsageDay, ...] = Field(
        default=(),
        description=(
            "The same window, one point per day, oldest first and dense — a day with no calls is "
            "a zero rather than a missing point, because this table records every call. This is "
            "what a usage chart is drawn from; the totals above are its sum."
        ),
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
    return await _usage_for(principal, session, quota, plan_code, administrative=administrative)


async def _usage_for(
    principal: Principal,
    session: AsyncSession,
    quota: Quota,
    plan_code: PlanCode,
    *,
    administrative: bool,
) -> UsageResponse:
    """The whole answer for one person on one plan.

    Shared by the read and by the plan change, so the two cannot drift: a tier change returns the
    *recomputed* standing rather than the old one with a new name on it, which is what lets the
    screen show corrected allowances without a second round trip.
    """
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

    # The same rows, per day, for the chart. Read under the caller's own session like the totals
    # above, so Row Level Security scopes it — `aggregate_usage_series` takes no subject and needs
    # none. The two halves of its internal split are summed here: this route has always reported
    # the caller's own traffic as one number, and an ordinary account has no internal rows at all.
    end = datetime.now(UTC)
    buckets = await aggregate_usage_series(
        session,
        bucket="day",
        window=UsageWindow(start=end - timedelta(days=SUMMARY_DAYS), end=end),
    )
    per_day: dict[str, UsageDay] = {}
    for point in buckets:
        key = point.start.date().isoformat()
        seen = per_day.get(key)
        tokens_so_far = seen.total_tokens if seen else None
        combined = (
            point.total_tokens
            if tokens_so_far is None
            else tokens_so_far + (point.total_tokens or 0)
        )
        per_day[key] = UsageDay(
            date=key,
            calls=(seen.calls if seen else 0) + point.calls,
            failures=(seen.failures if seen else 0) + point.failures,
            total_tokens=combined,
        )

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
            series=tuple(per_day[key] for key in sorted(per_day)),
        ),
    )


# =========================================================================== choosing a tier


class PlanSelectionRequest(BaseModel):
    """Which tier the acting person wants to be on.

    ``PlanCode`` rather than a string, so a body naming a tier that does not exist is refused by
    validation before the handler runs, with the offending field named. There is no subject field
    and there will not be one: see the route below.
    """

    model_config = ConfigDict(extra="forbid")

    plan_code: PlanCode


@router.put("/me/plan", response_model=UsageResponse, summary="Choose your plan")
async def choose_plan(
    request: Request,
    body: PlanSelectionRequest,
    principal: RequiredPrincipal,
    session: CurrentSession,
    quota: Quota,
    administrative: IsAdministrative,
) -> UsageResponse:
    """Move yourself between tiers, and read back what that changed.

    **Whose plan, is not a question this route can be asked.** Like ``GET /me/usage`` it takes no
    subject: the row written is the validated token's, and `0015`'s ``WITH CHECK`` on both verbs
    means a request shaped to name somebody else writes nothing rather than writing their row. The
    absence of the parameter and the database's refusal say the same thing twice, which is the
    pattern this codebase already uses for the one table where a permissive write would matter.

    **Nothing is charged, because nothing bills.** ``specs/usage-limits``' refusal of payment
    processing is untouched: there is no checkout, no card, no invoice and no subscription record,
    and pricing is not published. A tier is an allowance and a class of model, and choosing one is
    free in the literal sense.

    **Usage is not reset.** The counters, the recorded events, the conversations, the saved
    locations and the watches are all untouched — a tier says what you may do next, not what you
    have already done. Consumption is counted per window, so a person who has used 37 requests and
    moves to a plan allowing 25 has used 37 of 25: the response says so rather than quietly
    forgiving the difference or deleting the history that produced it.

    Returns the same shape ``GET /me/usage`` does, recomputed against the new plan, so a screen can
    show corrected allowances without asking twice.
    """
    annotate(request, acting_user_id=principal.user_id)
    await ensure_profile(session, principal)

    plan = await PlanStore(session).choose(body.plan_code, subject=principal.user_id)
    logger.info("plan self-selected", extra={"plan_code": str(plan.plan_code)})
    return await _usage_for(
        principal, session, quota, plan.plan_code, administrative=administrative
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
    """A tier, its standing, what it allows, and which class of model answers on it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    plan_code: str
    display_name: str
    rank: int = Field(description="Ascending entitlement. Free is the lowest.")
    allowances: tuple[PlanAllowanceView, ...]
    model_tier: str | None = Field(
        default=None,
        description=(
            "The capability tier of the first model this plan's synthesis policy would resolve — "
            "economy, standard or frontier. Null where the plan maps no synthesis policy, or where "
            "its policy names no enabled candidate. Read from the catalog, never asserted."
        ),
    )
    model_name: str | None = Field(
        default=None,
        description="That model's display name, so a comparison can say what actually differs.",
    )


class PlansResponse(BaseModel):
    """The tiers Weathra offers, and how somebody moves between them.

    ``self_service`` is the field that keeps this page honest, and what it means is narrow: whether
    a caller can **move themselves** between tiers. Since the product decision of 2026-09-13 they
    can — ``PUT /me/plan`` — so it is true.

    It is emphatically **not** a claim that anything is bought. Weathra bills nobody: there is no
    payment integration, no checkout, no card, no invoice and no subscription record, and no price
    is published. A tier controls allowances and which class of model answers; choosing one records
    a row and charges nothing. ``assignment_note`` is where that is said in words, because a
    pricing surface that let a person pick Premium without saying why it costs nothing would be
    describing a commercial relationship this product does not have just as surely as a Buy button
    would.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    count: int = Field(ge=0)
    plans: tuple[PlanOfferView, ...]
    default_plan: str = Field(description="What a new account is on before anybody assigns a tier.")
    self_service: bool = Field(
        default=False,
        description=(
            "Whether a caller can move themselves between tiers through 'PUT /me/plan'. True says "
            "the tier is selectable, never that it is purchasable: no payment exists either way."
        ),
    )
    assignment_note: str


ASSIGNMENT_NOTE = (
    "Free is what every new account is on, and you can move yourself to Pro or Premium at any "
    "time. Tiers control what Weathra allows you and which class of model answers you — pricing "
    "is not published, there is no payment integration in this product, and changing tier never "
    "charges your account."
)


@router.get("/plans", response_model=PlansResponse, summary="The subscription tiers")
async def list_offered_plans(request: Request, session: CurrentSession) -> PlansResponse:
    """What the tiers are and what each allows. Public, because it is a pricing question.

    Nothing here is per-caller: no subject is read and no usage is counted, so it answers the same
    way signed in or not — including ``self_service``, which is a property of the product rather
    than of whoever is asking. The caller's *own* standing is `/me/usage`, which is protected, and
    moving between tiers is ``PUT /me/plan``, which is protected for the same reason.
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

    # What actually differs between tiers, besides how much they allow: which model answers.
    # `subscription_plans` maps each call role to a policy, the policy orders catalog candidates,
    # and the catalog entry carries the capability tier. All three are rows; none of it is asserted
    # here. A plan that maps no synthesis policy, or whose policy names nothing enabled, reports
    # null rather than a guess.
    headline = await _headline_model(session, plans)

    return PlansResponse(
        count=len(plans),
        plans=tuple(
            PlanOfferView(
                plan_code=str(plan.plan_code),
                display_name=plan.display_name,
                rank=plan.rank,
                allowances=tuple(by_plan.get(str(plan.plan_code), ())),
                model_tier=headline.get(str(plan.plan_code), (None, None))[0],
                model_name=headline.get(str(plan.plan_code), (None, None))[1],
            )
            for plan in sorted(plans, key=lambda plan: plan.rank)
        ),
        default_plan=str(DEFAULT_PLAN),
        self_service=True,
        assignment_note=ASSIGNMENT_NOTE,
    )


async def _headline_model(
    session: AsyncSession, plans: Sequence[PlanRecord]
) -> dict[str, tuple[str | None, str | None]]:
    """Per plan, the tier and name of the first model its synthesis policy would resolve.

    *Synthesis* rather than routing, because synthesis is the call that writes the answer a person
    reads — it is the one whose model they would notice. The first *enabled* candidate, because a
    disabled row is unavailable everywhere (`specs/model-catalog`) and naming it would describe a
    model no call can reach.
    """
    policies = {str(record.policy_id): record for record in await PolicyStore(session).list()}
    catalog = {entry.catalog_key: entry for entry in await CatalogStore(session).list()}

    resolved: dict[str, tuple[str | None, str | None]] = {}
    for plan in plans:
        policy_id = plan.policy_for(CallRole.SYNTHESIS)
        policy = policies.get(str(policy_id)) if policy_id else None
        if policy is None:
            resolved[str(plan.plan_code)] = (None, None)
            continue
        for key in policy.candidate_catalog_keys:
            entry = catalog.get(key)
            if entry is not None and entry.status is CatalogStatus.ENABLED:
                resolved[str(plan.plan_code)] = (entry.capability_tier.value, entry.display_name)
                break
        else:
            resolved[str(plan.plan_code)] = (None, None)
    return resolved
