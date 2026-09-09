"""The administrative control plane: the model catalog, the policies, the plans, and usage.

Four properties hold across every route in this package, and they are worth stating once here
rather than repeating in each module.

**Authorization is a dependency, not a check.** Every route takes ``AdministrativePrincipal``,
which resolves ``admin_roles`` for the validated subject (`specs/authentication`). There is no
route here whose handler could run without it, so there is no route here where somebody can forget
the check — which is the failure mode a per-handler ``if`` eventually produces.

**The privileged connection is unobtainable without the role.** ``AdministrativeSession`` depends
on ``AdministrativePrincipal``, so the dependency graph itself refuses to open the connection for a
caller who does not hold the role. It is *not* obtained by the route and then guarded; it cannot be
obtained at all. Privileged is necessary here for the reason `0005` and `0006` state: the request
role is granted `SELECT` and nothing else on every operational table, precisely so administration
cannot happen on the request path.

**Nothing here reads a user-owned row.** The catalog, the policies, the plans and the allowances
are operational. Plan assignment writes `user_plans` — entitlement state the request role is
deliberately not allowed to write — and the usage router returns aggregates rather than rows. No
route in this package can return another person's thread, preference, saved location, evidence
record or individual usage event, and a test asserts it over the source.

**Every mutation goes through the group 27 stores.** They hold the validation and they write
`admin_audit` in the same transaction as the change. A route reaching for SQL directly would be a
second way to change a policy — one with its own validation and its own chance of forgetting to
record what it did.
"""

from __future__ import annotations

from weathra.api.routers.admin import lab as admin_lab
from weathra.api.routers.admin import models as admin_models
from weathra.api.routers.admin import plans as admin_plans
from weathra.api.routers.admin import usage as admin_usage
from weathra.api.routers.admin.deps import AdministrativeSession, administrative_db

__all__ = ["AdministrativeSession", "administrative_db", "routers"]

# Registered by `api/app.py` in this order, which is also the order they appear in the schema.
routers = (admin_models.router, admin_plans.router, admin_usage.router, admin_lab.router)
