---
id: forecast-uncertainty
title: Forecast uncertainty and the horizon
topic: uncertainty
provenance: >
  Written for Weathra from published numerical weather prediction and ensemble forecasting
  literature. Explanatory only; contains no measurements for any location.
---

# Forecast uncertainty and the horizon

Forecast skill decays with time, and it does so for a reason that cannot be engineered away.

## Why skill decays

The atmosphere is a chaotic system: two states differing by an amount too small to measure will
diverge, and the divergence grows roughly exponentially. A forecast starts from an imperfect picture
of the current atmosphere — observations are sparse over oceans and at altitude — and that initial
error grows as the model integrates forward.

The practical consequence is a rough hierarchy. Under about two days, forecasts of temperature and
the general pattern are usually reliable. Out to about five days, the large-scale pattern is often
right while timing and detail drift. Beyond about a week, useful information is mostly about
tendencies rather than specific days, and beyond about two weeks little deterministic skill
remains.

Different quantities decay at different rates. Temperature is more predictable than precipitation,
because temperature is smooth and large-scale while showers are small and intermittent. Position
errors matter more for precipitation: a front arriving eighty kilometres from where the model put it
is a good forecast of the pattern and a wrong forecast for a particular town.

## How uncertainty is estimated

Ensemble forecasting is the standard method: run the model many times from slightly different
initial states and with slightly different physics, and read the spread of the results. Tight
spread means the situation is well-constrained; wide spread means genuinely uncertain, whatever the
central value says.

A **consensus** across independent models is a second, different signal. When several
independently-built models agree, confidence is higher than any one of them justifies alone; when
they disagree, the disagreement is itself the finding.

## What Weathra can and cannot say

Weathra reads a single provider. It therefore has no consensus signal — there is no second model to
disagree — and its confidence assessment rests on two things only: how far into the horizon a
figure sits, and whatever spread the provider itself supplies. Weathra states that basis with every
uncertainty statement rather than presenting a confidence figure whose derivation is hidden, and it
does not produce forecasts of its own: it retrieves a provider's model output, analyses it
deterministically, and explains it.
