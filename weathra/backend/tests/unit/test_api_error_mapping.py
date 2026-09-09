"""Task 26.1's mapping half — every error reaches HTTP through one place, and lands somewhere.

``api/errors.py`` claims to be the single mapping point and says a completeness test can enumerate
the hierarchy and assert every class maps somewhere. Nothing enumerated it until now, which meant
the four errors group 26 adds could have been declared and never mapped — and a new error class
that falls through to the generic 500 is exactly the kind of thing that is discovered by a caller
rather than by CI.

The mapping is a dict walked by method resolution order, so "exactly one status" is a property of
the walk rather than of the table: a class inherits its parent's status unless it declares its own,
and the first match along the MRO is the answer. Both halves are asserted below.
"""

from __future__ import annotations

import pytest
from fastapi import status

from weathra.api.errors import _STATUS_BY_ERROR, status_for
from weathra.domain import errors as e

# The statuses group 26's errors are required to produce. Written out rather than derived, because
# the point of the test is to disagree with the table when somebody changes it by accident.
ENTITLEMENT_STATUS: dict[type[e.WeathraError], int] = {
    # A named model that the catalog does not vouch for is a bad request, refused before any
    # network call rather than attempted and reported afterwards.
    e.ModelNotAllowlisted: status.HTTP_400_BAD_REQUEST,
    # A disable that would strand a call role: refused as a bad request, and re-sendable with
    # an acknowledgement, which is why it is a 400 and not a 409 the caller cannot act on.
    e.ModelRoleWouldBeUnavailable: status.HTTP_400_BAD_REQUEST,
    # The subscription saying no. Shares 429 with a gateway rate limit and is a different code.
    e.QuotaExceeded: status.HTTP_429_TOO_MANY_REQUESTS,
    # Configuration failures: the caller asked for something reasonable and the deployment has
    # nothing entitled to serve it, or could not find out.
    e.NoEligibleModel: status.HTTP_503_SERVICE_UNAVAILABLE,
    e.PolicyUnavailable: status.HTTP_503_SERVICE_UNAVAILABLE,
}


@pytest.mark.parametrize(
    ("error_class", "expected"),
    list(ENTITLEMENT_STATUS.items()),
    ids=[cls.__name__ for cls in ENTITLEMENT_STATUS],
)
def test_each_entitlement_error_maps_to_its_status(
    error_class: type[e.WeathraError], expected: int
) -> None:
    assert status_for(error_class) == expected
    assert status_for(error_class("something went wrong")) == expected


def test_every_error_class_maps_to_exactly_one_status() -> None:
    """One answer per class, and the same answer from the class and from an instance."""
    for error_class in e.all_error_classes():
        from_class = status_for(error_class)
        from_instance = status_for(error_class("a message"))
        assert from_class == from_instance
        assert 400 <= from_class <= 599

        matches = [candidate for candidate in error_class.__mro__ if candidate in _STATUS_BY_ERROR]
        assert matches, f"{error_class.__name__} matches no entry in the mapping"
        assert _STATUS_BY_ERROR[matches[0]] == from_class, (
            f"{error_class.__name__} resolves to a status other than its nearest entry"
        )


def test_only_the_base_error_falls_through_to_a_generic_500() -> None:
    """A new subclass landing on 500 by omission is the failure this test exists for.

    ``WeathraError`` itself maps there deliberately — something genuinely unexpected is a 500 — but
    every named condition below it has been given a status on purpose.
    """
    generic = [
        error_class.__name__
        for error_class in e.all_error_classes()
        if error_class is not e.WeathraError
        and status_for(error_class) == status.HTTP_500_INTERNAL_SERVER_ERROR
    ]
    assert not generic, f"these errors have no status of their own and default to 500: {generic}"


def test_a_quota_refusal_is_distinguishable_from_a_gateway_rate_limit() -> None:
    """`specs/usage-limits` requires the two to be tellable apart.

    They share a status, and must: both mean "not now". They differ by code, which is what a client
    branches on — one clears on its own and the other does not until the window turns over, so a
    client that could not tell them apart would retry the first forever.
    """
    assert status_for(e.QuotaExceeded) == status_for(e.ProviderRateLimited)
    assert e.QuotaExceeded.code != e.ProviderRateLimited.code
    assert e.QuotaExceeded.code == "quota_exceeded"
    assert e.ProviderRateLimited.code == "provider_rate_limited"


def test_a_quota_refusal_is_not_an_authentication_or_upstream_failure() -> None:
    """The rest of the same requirement: distinguishable from an authentication failure, an
    upstream failure and an agent-unconfigured failure."""
    quota = status_for(e.QuotaExceeded)
    assert quota != status_for(e.AuthenticationFailed)
    assert quota != status_for(e.ProviderUnavailable)
    assert quota != status_for(e.AgentNotConfigured)
    assert not issubclass(e.QuotaExceeded, e.AuthenticationFailed)
    assert not issubclass(e.QuotaExceeded, e.ValidationFailed)


def test_no_eligible_model_is_a_configuration_failure_and_not_the_callers_fault() -> None:
    """It sits with the other "a dependency is not up" conditions rather than with the 400s: the
    request was fine and the deployment has nothing entitled to serve it."""
    assert status_for(e.NoEligibleModel) == status_for(e.AgentNotConfigured)
    assert not issubclass(e.NoEligibleModel, e.ValidationFailed)


def test_an_off_catalog_model_is_a_validation_failure() -> None:
    """The opposite case: something named a model the allowlist does not carry, which is a
    property of the request."""
    assert issubclass(e.ModelNotAllowlisted, e.ValidationFailed)
    assert status_for(e.ModelNotAllowlisted) == status.HTTP_400_BAD_REQUEST


def test_the_mapping_is_the_only_place_a_status_is_decided() -> None:
    """Decision 16, restated as a check: no error class carries its own status attribute, so there
    is nothing for a second mapping to read."""
    for error_class in e.all_error_classes():
        assert not hasattr(error_class, "status_code")
        assert not hasattr(error_class, "http_status")
