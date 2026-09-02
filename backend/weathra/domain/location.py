"""The canonical location, and the result of trying to resolve one.

One point on the map, one timezone, one stable identifier. Everything above this — forecasts,
history, analytics, comparison, saved locations, the cache — keys off it.

Two decisions worth stating:

* **Ambiguity is a return value, not an exception.** ``specs/http-api`` requires an ambiguous name
  to be a *successful*, distinguishable response carrying its candidates, so ``Resolution`` is a
  tagged union of ``Resolved | Ambiguous`` rather than a location-or-raise.
* **The identifier is derived from coordinates, rounded to two decimals** (~1.1 km). It has to be
  stable across the two ways a caller can name the same place: geocoding "Reykjavik" yields
  64.1466, -21.9426 while a caller typing coordinates supplies 64.15, -21.94. Keying on the raw
  floats would make those two different places and break the "same place, same identifier"
  requirement in ``specs/location-resolution``. Provider grids are kilometre-scale anyway, so a
  1.1 km bucket merges points whose weather is identical. Note this is deliberately coarser than
  the cache key's four decimals (design.md decision 8), which exists to avoid *upstream calls*
  rather than to establish identity.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from weathra.domain.errors import ValidationFailed

__all__ = [
    "IDENTIFIER_DECIMALS",
    "Ambiguous",
    "Location",
    "Resolution",
    "Resolved",
    "location_identifier",
    "validate_coordinates",
]

# Rounding behind the stable identifier. Two decimals ≈ 1.1 km of latitude.
IDENTIFIER_DECIMALS = 2

Latitude = Annotated[float, Field(ge=-90.0, le=90.0)]
Longitude = Annotated[float, Field(ge=-180.0, le=180.0)]


def _normalize(value: float) -> float:
    """Round for identity, and collapse ``-0.0`` so the sign of zero cannot split a bucket."""
    rounded = round(value, IDENTIFIER_DECIMALS)
    return rounded + 0.0


def location_identifier(latitude: float, longitude: float) -> str:
    """The stable identifier for a point. Same place in, same string out."""
    lat = _normalize(latitude)
    lon = _normalize(longitude)
    return f"loc:{lat:.{IDENTIFIER_DECIMALS}f},{lon:.{IDENTIFIER_DECIMALS}f}"


def validate_coordinates(latitude: float, longitude: float) -> tuple[float, float]:
    """Check a caller-supplied coordinate pair, naming the offending field on failure.

    The geocoding layer calls this so a bad pair becomes a coded ``ValidationFailed`` naming the
    field rather than a pydantic error shaped for a different audience.
    """
    if not -90.0 <= latitude <= 90.0:
        raise ValidationFailed(
            f"Latitude {latitude} is out of range; it must be between -90 and 90.",
            details={"field": "latitude", "value": latitude, "minimum": -90.0, "maximum": 90.0},
        )
    if not -180.0 <= longitude <= 180.0:
        raise ValidationFailed(
            f"Longitude {longitude} is out of range; it must be between -180 and 180.",
            details={"field": "longitude", "value": longitude, "minimum": -180.0, "maximum": 180.0},
        )
    return latitude, longitude


class Location(BaseModel):
    """A resolved place: where it is, what it is called, and what time it is there."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    display_name: str = Field(min_length=1, description="What a person reads, e.g. 'Reykjavík'.")
    latitude: Latitude
    longitude: Longitude
    timezone: str = Field(
        min_length=1,
        description=(
            "IANA identifier, e.g. 'Atlantic/Reykjavik'. Every window is resolved to UTC bounds "
            "from this, never from the server's own timezone."
        ),
    )
    region: str | None = Field(default=None, description="First-order administrative area.")
    country: str | None = None
    country_code: str | None = Field(default=None, min_length=2, max_length=2)
    elevation_metres: float | None = None

    @field_validator("display_name", "region", "country", mode="before")
    @classmethod
    def _strip(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("country_code")
    @classmethod
    def _upper_country_code(cls, value: str | None) -> str | None:
        return value.upper() if value else value

    @field_validator("timezone")
    @classmethod
    def _known_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"{value!r} is not a known IANA timezone identifier") from exc
        return value

    @property
    def identifier(self) -> str:
        """The stable, coordinate-derived identifier. Saved locations and caches key on it."""
        return location_identifier(self.latitude, self.longitude)

    @property
    def zoneinfo(self) -> ZoneInfo:
        """The location's timezone, for resolving a local window to UTC bounds."""
        return ZoneInfo(self.timezone)

    @property
    def qualified_name(self) -> str:
        """Display name with whatever qualifiers distinguish it: 'Springfield, Illinois, US'."""
        parts = [self.display_name, self.region, self.country_code or self.country]
        return ", ".join(part for part in parts if part)

    def is_same_place(self, other: Location) -> bool:
        """Two locations name the same place when their stable identifiers agree."""
        return self.identifier == other.identifier


class Resolved(BaseModel):
    """Exactly one location matched."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["resolved"] = "resolved"
    query: str = Field(min_length=1, description="What the caller asked for, verbatim.")
    location: Location


class Ambiguous(BaseModel):
    """Several distinct locations matched and no qualifier chose between them.

    Reported rather than guessed: the caller picks. Each candidate carries region and country so
    they can actually be told apart.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["ambiguous"] = "ambiguous"
    query: str = Field(min_length=1)
    candidates: tuple[Location, ...] = Field(min_length=2)

    @model_validator(mode="after")
    def _candidates_are_distinct(self) -> Self:
        identifiers = [candidate.identifier for candidate in self.candidates]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError(
                "Ambiguous candidates must be distinct places; duplicates mean the resolver "
                "returned the same point twice rather than a genuine ambiguity."
            )
        return self


Resolution = Annotated[Resolved | Ambiguous, Field(discriminator="kind")]
"""What resolving a place name produced. Unresolvable is ``LocationNotFound``, not a variant."""
