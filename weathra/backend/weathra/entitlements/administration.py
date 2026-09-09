"""Who counts as an administrator, read from the validated token and from nothing else.

One predicate, in one place, because the alternative is each caller deciding for itself what an
administrator is — and the first one to get it slightly wrong is the one that matters.

**Why a token claim and not a database row.** ``specs/model-policy`` requires `admin_experimental`
to be "gated on the administrative role rather than on any plan row, so no plan row can accidentally
grant it". A plan row is exactly the thing a plan-assignment bug could set; an identity provider's
claim is not reachable from the plan store at all. The two failure modes are therefore independent,
which is the point of separating them.

**Why this is not a client-supplied field.** The claims a `Principal` carries came out of a token
whose signature, issuer, audience and expiry were already checked (`auth/tokens.py`), and a
`Principal` is the only identity the request path has (design.md decision 4). A body field or a
header naming a role reaches nothing here, because nothing here reads a request.

**What group 31 owns and this does not.** Assigning the role, the administrative API surface, and
the audit of who granted it are task group 31. This module answers one question — *is the acting
principal an administrator right now* — which the resolver needs before group 31 exists. When that
group lands it changes where the claim comes from, not what any caller of this asks.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from weathra.domain.identity import Principal

__all__ = [
    "ADMINISTRATOR_ROLE",
    "ROLE_CLAIM",
    "is_administrative",
]

# The claim naming Weathra's own roles. Deliberately namespaced: Supabase's own `role` claim says
# `authenticated` for every signed-in person, and a system that read *that* would make every user
# an administrator the moment somebody reused the name.
ROLE_CLAIM = "weathra_role"

ADMINISTRATOR_ROLE = "administrator"

# Where an identity provider may nest custom claims. Supabase puts them under `app_metadata`, which
# is server-controlled — `user_metadata` is *not*, and is deliberately absent from this list: it is
# writable by the account holder, so reading a role from it would let anyone promote themselves.
_CLAIM_CONTAINERS = ("app_metadata",)


def _declared_roles(claims: Mapping[str, Any]) -> frozenset[str]:
    """Every Weathra role the validated claim set declares, top level or nested."""
    found: set[str] = set()
    sources: list[Any] = [claims.get(ROLE_CLAIM)]
    for container in _CLAIM_CONTAINERS:
        nested = claims.get(container)
        if isinstance(nested, Mapping):
            sources.append(nested.get(ROLE_CLAIM))

    for value in sources:
        if isinstance(value, str):
            found.add(value.strip().lower())
        elif isinstance(value, list | tuple | set | frozenset):
            found.update(str(item).strip().lower() for item in value)
    return frozenset(role for role in found if role)


def is_administrative(principal: Principal | None) -> bool:
    """Whether *principal* holds Weathra's administrative role.

    ``None`` is not an administrator, which is worth stating rather than leaving to the truthiness
    of a missing object: an unauthenticated call is the one case where a permissive default would
    be catastrophic and would look like an oversight rather than a decision.
    """
    if principal is None:
        return False
    return ADMINISTRATOR_ROLE in _declared_roles(principal.claims)
