"""The model catalog repository: what Weathra is allowed to call, and who may change it.

Reads are ordinary. The administration is where the requirements are, and every one of
``specs/model-catalog``'s refusals is implemented here *as well as* in the table's constraints —
which is not duplication for its own sake.

**Why both.** A constraint refuses the write from every path, including a hand-written `UPDATE`
during an incident, and that is why they exist. But a constraint's error is a
``ck_model_catalog_prices_non_negative`` violation, which is the right thing for the database to
say and the wrong thing for an administrator to read. So this layer refuses first and names the
field, and the constraint stands behind it as the guarantee. Where they disagree, the constraint
wins and the disagreement is a bug in this file.

**The one refusal only this layer can make.** "Disabling the last enabled entry for a capability
role that a shipped policy requires SHALL be refused unless the request explicitly acknowledges the
resulting unavailability" is a statement about the catalog *and* the policies together, across
rows. No CHECK constraint can express it. It is the reason this module is not a thin wrapper: the
question "would this disable strand a call role" needs the policies in hand, and an administrator
who says yes anyway is making a decision the system should record rather than prevent.

**Nothing here deletes a catalog row.** Disabling is the sanctioned response to a model that has
stopped working, because a deleted row would break the foreign keys that keep recorded usage and
evaluation results attributed — ``specs/model-catalog`` requires that history to survive.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.domain.entitlements import CallRole
from weathra.domain.errors import (
    ModelRoleWouldBeUnavailable,
    RecordNotFound,
    ValidationFailed,
)
from weathra.entitlements.audit import record_change
from weathra.entitlements.records import (
    AdminAction,
    CapabilityTier,
    CatalogEntry,
    CatalogStatus,
)

__all__ = ["CATALOG_SUBJECT_KIND", "CatalogStore"]

logger = logging.getLogger("weathra.entitlements.catalog")

# What an audit row calls this kind of record.
CATALOG_SUBJECT_KIND = "model_catalog"

_COLUMNS = (
    "catalog_key, gateway_provider, gateway_model, display_name, capability_roles, "
    "capability_tier, supports_structured_output, context_window, input_price_per_million, "
    "output_price_per_million, price_currency, pricing_recorded_on, status, is_free_tier"
)

# The fields an edit may change. `catalog_key` is absent on purpose: it is the stable handle every
# policy, usage event and comparison result references, so renaming it is a data migration and not
# an edit. `gateway_model` *is* here, because a gateway rename is exactly the one-row update the
# key/vendor split exists to make possible.
EDITABLE_FIELDS = frozenset(
    {
        "gateway_provider",
        "gateway_model",
        "display_name",
        "capability_roles",
        "capability_tier",
        "supports_structured_output",
        "context_window",
        "input_price_per_million",
        "output_price_per_million",
        "price_currency",
        "pricing_recorded_on",
        "is_free_tier",
    }
)


def _entry_from_row(row: Any) -> CatalogEntry:
    return CatalogEntry(
        catalog_key=row[0],
        gateway_provider=row[1],
        gateway_model=row[2],
        display_name=row[3],
        capability_roles=tuple(CallRole(role) for role in row[4]),
        capability_tier=CapabilityTier(row[5]),
        supports_structured_output=row[6],
        context_window=row[7],
        input_price_per_million=row[8],
        output_price_per_million=row[9],
        price_currency=row[10],
        pricing_recorded_on=row[11],
        status=CatalogStatus(row[12]),
        is_free_tier=row[13],
    )


def _refuse(field: str, message: str) -> ValidationFailed:
    return ValidationFailed(message, details={"field": field})


class CatalogStore:
    """Catalog reads for the request path, and catalog administration for the privileged one.

    One class rather than two because the validation is the same either way, and a second class
    would eventually validate slightly differently. The *connection* is what separates them: the
    read methods work under the restricted request session, and every write needs the privileged
    one, because ``model_catalog`` grants the request role ``SELECT`` and nothing more.
    """

    __slots__ = ("_session",)

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # ---------------------------------------------------------------- reads

    async def get(self, catalog_key: str) -> CatalogEntry | None:
        """One entry by its stable key, whatever its status.

        Returns a disabled entry rather than hiding it: callers ask different questions of it —
        an override needs to know a model is *disabled* rather than *unknown*, and the two produce
        different errors.
        """
        row = (
            await self._session.execute(
                text(f"SELECT {_COLUMNS} FROM model_catalog WHERE catalog_key = :key"),
                {"key": catalog_key},
            )
        ).one_or_none()
        return None if row is None else _entry_from_row(row)

    async def require(self, catalog_key: str) -> CatalogEntry:
        """One entry, or a structured not-found naming the key."""
        entry = await self.get(catalog_key)
        if entry is None:
            raise RecordNotFound(
                f"No catalog entry named {catalog_key!r}.", details={"catalog_key": catalog_key}
            )
        return entry

    async def list(
        self,
        *,
        status: CatalogStatus | None = None,
        capability_role: CallRole | None = None,
    ) -> tuple[CatalogEntry, ...]:
        """The catalog, optionally narrowed by status and by capability role.

        Both filters are what ``specs/model-catalog`` asks an administrative reader for, and the
        role filter is also how "is there an enabled entry for this role" is answered — by the
        seed check, by the disable refusal below, and by nothing that hard-codes a list of models.
        """
        rows = await self._session.execute(
            text(
                f"SELECT {_COLUMNS} FROM model_catalog "
                # Every optional filter is cast explicitly. asyncpg infers a parameter's type from
                # its use, and `:p IS NULL OR col = :p` gives it two conflicting hints, so it
                # refuses the statement outright rather than guessing.
                " WHERE (CAST(:status AS text) IS NULL OR status = CAST(:status AS text)) "
                "   AND (CAST(:role AS text) IS NULL "
                "        OR CAST(:role AS text) = ANY(capability_roles)) "
                " ORDER BY catalog_key"
            ),
            {
                "status": status.value if status else None,
                "role": capability_role.value if capability_role else None,
            },
        )
        return tuple(_entry_from_row(row) for row in rows)

    async def enabled_for(self, role: CallRole) -> tuple[CatalogEntry, ...]:
        """Every enabled entry fit for *role*. The set a policy's candidates are drawn from."""
        return await self.list(status=CatalogStatus.ENABLED, capability_role=role)

    # ---------------------------------------------------------------- validation

    def _validate(self, values: dict[str, Any]) -> None:
        """Every rule ``specs/model-catalog`` states about an entry's metadata.

        Applied to a create in full and to an edit over the merged result, so an edit cannot reach
        a state a create would have refused — which is the way half-validated administration
        surfaces usually go wrong.
        """
        roles = values.get("capability_roles") or ()
        if not roles:
            raise _refuse(
                "capability_roles",
                "A catalog entry must declare at least one capability role; an entry no role can "
                "use is one no policy can ever resolve.",
            )
        unknown = {str(role) for role in roles} - {role.value for role in CallRole}
        if unknown:
            raise _refuse("capability_roles", f"Unknown capability role(s): {sorted(unknown)}.")

        for field in ("input_price_per_million", "output_price_per_million"):
            price = values.get(field)
            if price is None:
                raise _refuse(
                    field,
                    f"{field} is required. A missing price makes cost estimation silently wrong "
                    "rather than absent.",
                )
            if Decimal(price) < 0:
                raise _refuse(field, f"{field} must not be negative, got {price}.")

        window = values.get("context_window")
        if window is None or int(window) <= 0:
            raise _refuse(
                "context_window",
                f"context_window must be a positive number of tokens, got {window}.",
            )

        currency = values.get("price_currency") or ""
        if len(str(currency)) != 3:
            raise _refuse(
                "price_currency",
                f"price_currency must be a 3-letter ISO 4217 code, got {currency!r}.",
            )

        if not values.get("pricing_recorded_on"):
            raise _refuse(
                "pricing_recorded_on",
                "A price must record the date it was read, or nothing can say how stale it is.",
            )

    async def _refuse_duplicate_gateway_identity(
        self, gateway_provider: str, gateway_model: str, *, excluding: str | None = None
    ) -> None:
        """Two catalog keys naming one upstream model make a usage event unattributable."""
        clash = await self._session.scalar(
            text(
                "SELECT catalog_key FROM model_catalog "
                " WHERE gateway_provider = :provider AND gateway_model = :model "
                "   AND (CAST(:excluding AS text) IS NULL "
                "        OR catalog_key <> CAST(:excluding AS text))"
            ),
            {"provider": gateway_provider, "model": gateway_model, "excluding": excluding},
        )
        if clash is not None:
            raise ValidationFailed(
                f"{clash!r} already points at that gateway provider and model. Two catalog keys "
                "for one upstream model would make 'which entry served this call' unanswerable.",
                details={"field": "gateway_model", "conflicting_catalog_key": clash},
            )

    # ---------------------------------------------------------------- administration

    async def create(
        self,
        *,
        acting_principal: str,
        catalog_key: str,
        gateway_provider: str,
        gateway_model: str,
        display_name: str,
        capability_roles: Sequence[CallRole],
        capability_tier: CapabilityTier,
        supports_structured_output: bool,
        context_window: int,
        input_price_per_million: Decimal | str,
        output_price_per_million: Decimal | str,
        pricing_recorded_on: date,
        is_free_tier: bool,
        price_currency: str = "USD",
        status: CatalogStatus = CatalogStatus.ENABLED,
    ) -> CatalogEntry:
        """Add an entry. Privileged, validated, and recorded."""
        values: dict[str, Any] = {
            "catalog_key": catalog_key,
            "gateway_provider": gateway_provider,
            "gateway_model": gateway_model,
            "display_name": display_name,
            "capability_roles": [role.value for role in capability_roles],
            "capability_tier": capability_tier.value,
            "supports_structured_output": supports_structured_output,
            "context_window": context_window,
            "input_price_per_million": Decimal(input_price_per_million),
            "output_price_per_million": Decimal(output_price_per_million),
            "price_currency": price_currency,
            "pricing_recorded_on": pricing_recorded_on,
            "status": status.value,
            "is_free_tier": is_free_tier,
        }
        self._validate(values)

        if await self.get(catalog_key) is not None:
            raise ValidationFailed(
                f"A catalog entry named {catalog_key!r} already exists.",
                details={"field": "catalog_key", "catalog_key": catalog_key},
            )
        await self._refuse_duplicate_gateway_identity(gateway_provider, gateway_model)

        await self._session.execute(
            text(
                f"INSERT INTO model_catalog ({_COLUMNS}) VALUES ("
                ":catalog_key, :gateway_provider, :gateway_model, :display_name, "
                "CAST(:capability_roles AS text[]), :capability_tier, :supports_structured_output, "
                ":context_window, CAST(:input_price_per_million AS numeric), "
                "CAST(:output_price_per_million AS numeric), :price_currency, "
                "CAST(:pricing_recorded_on AS date), :status, :is_free_tier)"
            ),
            values,
        )
        written = await self.require(catalog_key)
        await record_change(
            self._session,
            acting_principal=acting_principal,
            action=AdminAction.CATALOG_CREATE,
            subject_kind=CATALOG_SUBJECT_KIND,
            subject_id=catalog_key,
            after=_auditable(written),
        )
        return written

    async def edit(
        self, catalog_key: str, changes: Mapping[str, Any], *, acting_principal: str
    ) -> CatalogEntry:
        """Change an entry's metadata. Re-pricing, re-tiering, a gateway rename.

        ``status`` is not editable here — enabling and disabling go through their own methods,
        because disabling carries a cross-row refusal that a generic field update would skip.

        The changes arrive as a mapping rather than as ``**kwargs`` for a reason worth keeping: with
        ``**changes``, a caller writing ``edit(key, catalog_key="new")`` collides with the
        positional parameter and Python raises a ``TypeError`` before the refusal below can run —
        so the one field most worth refusing was the one field that could never reach the check.
        """
        before = await self.require(catalog_key)

        unknown = set(changes) - EDITABLE_FIELDS
        if unknown:
            raise _refuse(
                sorted(unknown)[0],
                f"Not an editable catalog field: {sorted(unknown)}. The catalog key is the stable "
                "handle every policy and recorded event references, and status has its own path.",
            )
        if not changes:
            return before

        merged = _auditable(before) | dict(changes)
        merged["capability_roles"] = [
            role.value if isinstance(role, CallRole) else str(role)
            for role in merged["capability_roles"]
        ]
        self._validate(merged)
        await self._refuse_duplicate_gateway_identity(
            str(merged["gateway_provider"]), str(merged["gateway_model"]), excluding=catalog_key
        )

        assignments = ", ".join(
            f"{field} = CAST(:{field} AS text[])"
            if field == "capability_roles"
            else f"{field} = :{field}"
            for field in changes
        )
        await self._session.execute(
            text(
                f"UPDATE model_catalog SET {assignments}, updated_at = now() "
                " WHERE catalog_key = :catalog_key"
            ),
            {field: merged[field] for field in changes} | {"catalog_key": catalog_key},
        )

        after = await self.require(catalog_key)
        await record_change(
            self._session,
            acting_principal=acting_principal,
            action=AdminAction.CATALOG_EDIT,
            subject_kind=CATALOG_SUBJECT_KIND,
            subject_id=catalog_key,
            before=_auditable(before),
            after=_auditable(after),
        )
        return after

    async def enable(self, catalog_key: str, *, acting_principal: str) -> CatalogEntry:
        """Make an entry resolvable again. Enabling strands nothing, so there is nothing to ask."""
        return await self._set_status(
            catalog_key,
            CatalogStatus.ENABLED,
            acting_principal=acting_principal,
            action=AdminAction.CATALOG_ENABLE,
        )

    async def disable(
        self,
        catalog_key: str,
        *,
        acting_principal: str,
        acknowledge_role_unavailability: bool = False,
    ) -> CatalogEntry:
        """Take an entry out of resolution, refusing to strand a call role unacknowledged.

        The refusal is the requirement, and the acknowledgement is the point of it: an
        administrator who genuinely means to leave a role with no model may say so, and the
        decision is then recorded as theirs rather than discovered later as an outage. Recorded
        usage and evaluation results for the model stay exactly as they are.
        """
        stranded = await self.roles_left_without_a_model(catalog_key)
        if stranded and not acknowledge_role_unavailability:
            raise ModelRoleWouldBeUnavailable(
                f"Disabling {catalog_key!r} would leave no enabled model for "
                f"{sorted(role.value for role in stranded)}, which a shipped policy requires. "
                "Re-send acknowledging that the role will have no available model.",
                details={
                    "catalog_key": catalog_key,
                    "roles": sorted(role.value for role in stranded),
                    "acknowledgement_required": "acknowledge_role_unavailability",
                },
            )
        if stranded:
            logger.warning(
                "disabling %s leaves no enabled model for %s; acknowledged by %s",
                catalog_key,
                sorted(role.value for role in stranded),
                acting_principal,
            )
        return await self._set_status(
            catalog_key,
            CatalogStatus.DISABLED,
            acting_principal=acting_principal,
            action=AdminAction.CATALOG_DISABLE,
        )

    async def roles_left_without_a_model(self, catalog_key: str) -> frozenset[CallRole]:
        """Which required call roles would have no enabled model left if *this* one went away.

        Read as a question rather than a rule so a caller can ask it before deciding — an
        administrative surface wants to warn before it refuses.

        "Required by a shipped policy" is read from the policy records rather than from a constant:
        the whole point of policies being data is that the set of required roles changes without a
        deployment, and a hard-coded list here would go stale the first time one did.
        """
        rows = await self._session.execute(
            text(
                "WITH required AS ("
                "  SELECT DISTINCT unnest(applicable_call_roles) AS role FROM model_policies"
                ")"
                " SELECT required.role FROM required "
                "  WHERE NOT EXISTS ("
                "    SELECT 1 FROM model_catalog "
                "     WHERE status = 'enabled' "
                "       AND catalog_key <> :key "
                "       AND required.role = ANY(capability_roles)"
                "  )"
                "    AND EXISTS ("
                "    SELECT 1 FROM model_catalog "
                "     WHERE status = 'enabled' "
                "       AND catalog_key = :key "
                "       AND required.role = ANY(capability_roles)"
                "  )"
            ),
            {"key": catalog_key},
        )
        return frozenset(CallRole(row[0]) for row in rows)

    async def _set_status(
        self,
        catalog_key: str,
        status: CatalogStatus,
        *,
        acting_principal: str,
        action: AdminAction,
    ) -> CatalogEntry:
        before = await self.require(catalog_key)
        if before.status is status:
            return before

        await self._session.execute(
            text(
                "UPDATE model_catalog SET status = :status, updated_at = now() "
                " WHERE catalog_key = :key"
            ),
            {"status": status.value, "key": catalog_key},
        )
        after = await self.require(catalog_key)
        await record_change(
            self._session,
            acting_principal=acting_principal,
            action=action,
            subject_kind=CATALOG_SUBJECT_KIND,
            subject_id=catalog_key,
            before={"status": before.status.value},
            after={"status": after.status.value},
        )
        return after


def _auditable(entry: CatalogEntry) -> dict[str, Any]:
    """An entry as plain JSON-able values, for the audit row and for merging an edit."""
    return {
        "gateway_provider": entry.gateway_provider,
        "gateway_model": entry.gateway_model,
        "display_name": entry.display_name,
        "capability_roles": [role.value for role in entry.capability_roles],
        "capability_tier": entry.capability_tier.value,
        "supports_structured_output": entry.supports_structured_output,
        "context_window": entry.context_window,
        "input_price_per_million": str(entry.input_price_per_million),
        "output_price_per_million": str(entry.output_price_per_million),
        "price_currency": entry.price_currency,
        "pricing_recorded_on": entry.pricing_recorded_on.isoformat(),
        "status": entry.status.value,
        "is_free_tier": entry.is_free_tier,
    }
