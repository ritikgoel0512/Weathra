"""What a satellite observation is, as Weathra records one.

**An observation, not a measurement and not a forecast.** The source this is built for — NASA's
Global Imagery Browse Services, chosen in `docs/satellite-source.md` — answers with an image, a
product name and a date. It supplies no cloud fraction, no temperature, no rain rate and no
classification, so this model carries none: every field below is something the service actually
stated, and there is deliberately nowhere to put a meteorological figure.

**Weathra does not look at the picture.** No vision-capable model is in the pipeline and no code
path here derives anything from a pixel. `INTERPRETATION_BOUNDARY` is the sentence that says so, and
it travels with the observation rather than being remembered by whatever renders it.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Self

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from weathra.domain.location import Location
from weathra.domain.weather import DataClass

__all__ = [
    "INTERPRETATION_BOUNDARY",
    "SatelliteCoverage",
    "SatelliteObservation",
]

#: What Weathra did and did not do with the image. Carried on every observation, because a surface
#: that showed the imagery without it would be inviting the reader to assume the product read it.
INTERPRETATION_BOUNDARY = (
    "Weathra retrieves and displays this imagery. It does not interpret it: no image analysis was "
    "performed, and nothing in this answer is derived from the picture."
)


class SatelliteCoverage(BaseModel):
    """The box the imagery covers, in degrees.

    Satellite imagery covers a region, never a point, and saying so is the difference between "the
    latest imagery over the Berlin area" and a claim about a street.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    south: float = Field(ge=-90, le=90)
    west: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)

    @model_validator(mode="after")
    def _corners_are_ordered(self) -> Self:
        if self.north <= self.south or self.east <= self.west:
            raise ValueError("A coverage box must have its north-east corner above its south-west.")
        return self

    @property
    def span_degrees(self) -> float:
        """How wide the box is in latitude, which is the figure a reader can picture."""
        return round(self.north - self.south, 4)


class SatelliteObservation(BaseModel):
    """One retrieved satellite image, with everything needed to say what it is.

    ``image_url`` is the provider's own request URL. It is a reference rather than the bytes on
    purpose: the image is never put in front of a language model, and an envelope carrying a
    megabyte of base64 would make that far too easy to do by accident.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    data_class: DataClass = DataClass.SATELLITE_OBSERVATION

    location: Location
    coverage: SatelliteCoverage
    provider: str = Field(min_length=1, description="The service that served the imagery.")
    product: str = Field(min_length=1, description="The provider's own name for what this is.")
    instrument: str | None = Field(
        default=None, description="The instrument and platform, where the provider names them."
    )

    observed_date: date = Field(description="The UTC day the composite covers.")
    retrieved_at: AwareDatetime

    image_url: str = Field(min_length=1, description="Where the imagery was retrieved from.")
    image_media_type: str = Field(min_length=1)
    image_bytes: int = Field(ge=0, description="The size of the response, as a fact about it.")

    attribution: str = Field(min_length=1, description="The acknowledgement the source asks for.")
    source_url: str = Field(min_length=1, description="The service's own documentation.")

    coverage_note: str = Field(min_length=1)
    freshness_note: str = Field(min_length=1)
    interpretation_note: str = INTERPRETATION_BOUNDARY

    @model_validator(mode="after")
    def _retrieved_at_is_utc(self) -> Self:
        if self.retrieved_at.utcoffset() != timedelta(0):
            raise ValueError("retrieved_at must be expressed in UTC.")
        return self

    @property
    def age(self) -> timedelta:
        """How old the observation is at retrieval, from the end of the day it covers."""
        end_of_day = datetime.combine(
            self.observed_date, datetime.min.time(), tzinfo=self.retrieved_at.tzinfo
        ) + timedelta(days=1)
        return max(timedelta(0), self.retrieved_at - end_of_day)
