"""What a call cost, estimated deterministically from tokens and the price that applied to it.

A pure function over two inputs and nothing else. No clock, no database, no language model — a cost
produced by a model would be a number with no method behind it, and `specs/llm-telemetry` forbids
it explicitly.

**Null is the answer when it is the answer.** Unknown token counts mean unknown cost. Returning
zero instead would put "this call was free" into an aggregate as a measured fact, and a hundred
unknown calls would read as a hundred free ones. The distinction survives all the way to the
column, which is nullable for the same reason.

**The price travels with the event, not with the catalog.** `estimate` takes the prices as
arguments rather than looking them up, so the caller has to have the row that applied *at the time
of the call*. Re-pricing a catalog entry then cannot rewrite history, because history holds its own
copy — which is what `specs/model-catalog` requires and what makes a monthly total stable.

**Decimal, never float.** `0.1 + 0.2` is not `0.3` in binary floating point, and a cost total over
a month is thousands of such additions. Money is decimal arithmetic; the column is `NUMERIC`, and
this module never converts through `float` on the way there.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

__all__ = ["PER_MILLION", "CostEstimate", "estimate"]

from pydantic import BaseModel, ConfigDict, Field

# Catalog pricing is quoted per million tokens, which is how gateways publish it and how a person
# compares two models. The division happens once, here.
PER_MILLION = Decimal(1_000_000)


class CostEstimate(BaseModel):
    """An estimated cost, with the basis that produced it.

    The basis is not decoration: `specs/llm-telemetry` requires the currency and the pricing basis
    to be recorded alongside the figure, so that a total can be re-derived and a re-priced catalog
    can be told apart from a re-computed estimate.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    amount: Decimal = Field(ge=0)
    currency: str = Field(min_length=3, max_length=3)
    input_price_per_million: Decimal = Field(ge=0)
    output_price_per_million: Decimal = Field(ge=0)


def estimate(
    *,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    input_price_per_million: Decimal | str | int | None,
    output_price_per_million: Decimal | str | int | None,
    currency: str | None,
) -> CostEstimate | None:
    """The estimated cost of one call, or ``None`` where it cannot be known.

    ``None`` for any missing input, and that is four separate cases rather than one: unknown prompt
    tokens, unknown completion tokens, a catalog entry with no price, and no currency to express
    the answer in. Each is a real state — a gateway that reported no usage, a model priced after
    the fact — and none of them is zero.

    A zero *price* is different and is honoured: a free-tier model genuinely costs nothing, and
    reporting `0.00 USD` for it is a measured fact rather than an absence. That distinction is why
    the guard below tests for ``None`` rather than for falsiness.
    """
    if prompt_tokens is None or completion_tokens is None:
        return None
    if input_price_per_million is None or output_price_per_million is None:
        return None
    if not currency:
        return None

    try:
        input_price = Decimal(str(input_price_per_million))
        output_price = Decimal(str(output_price_per_million))
    except (InvalidOperation, ValueError):
        return None

    if input_price < 0 or output_price < 0 or prompt_tokens < 0 or completion_tokens < 0:
        # A negative anywhere means the inputs are wrong rather than the cost being negative.
        # Reporting nothing is the honest answer; reporting a negative charge is not.
        return None

    amount = (Decimal(prompt_tokens) * input_price + Decimal(completion_tokens) * output_price) / (
        PER_MILLION
    )
    return CostEstimate(
        amount=amount,
        currency=currency,
        input_price_per_million=input_price,
        output_price_per_million=output_price,
    )
