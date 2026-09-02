---
id: data-classes
title: Observations, forecasts, and historical statistics
topic: data-classes
provenance: >
  Written for Weathra to define the data classes it labels every reported value with. Draws on
  standard meteorological practice. Explanatory only; contains no measurements for any location.
---

# Observations, forecasts, and historical statistics

Three kinds of weather number get confused constantly, and the confusion changes what a figure
means. Weathra labels every value it reports with its class for exactly this reason.

## Current conditions — an observation or nowcast

What is happening now, or the best available estimate of it. Ultimately from instruments —
stations, radar, satellites — though a value for a specific point is often interpolated from nearby
observations and a short model run, which is why "current" is more precisely "observation or
nowcast".

It describes the present. It carries an observation time, and that time is not always the moment
you asked.

## Forecast — provider model output

What a weather model expects. Produced by numerical weather prediction, uncertain by nature, and
degrading with distance into the horizon. Attributable to the provider whose model produced it and
to the cycle it came from.

A forecast is never a measurement. It is the output of a simulation, and a figure seven days out
deserves nothing like the confidence of one six hours out.

## Historical observation — what actually happened

Recorded past weather, from station records or a reanalysis archive. Fixed: it does not change, and
past weather cached indefinitely remains correct. Archives run some days behind the present, so the
most recent days may not be available yet — which is a coverage gap to state, not a zero to report.

## Historical statistic — computed from observations

A number *derived* from historical observations: a mean, a baseline, a percentile, an anomaly. Not
itself an observation, and not an official climate normal unless a meteorological authority
published it as one.

When Weathra computes a baseline, it labels it a statistic Weathra computed, states how many years
went into it, and does not present it as an authoritative normal.

## AI interpretation

Prose that explains retrieved data. Weathra separates it structurally from the data it describes:
every figure in an answer comes from a retrieved value or a deterministic computation, and the
interpretation is labelled as interpretation. A language model in Weathra never produces a
measurement or a statistic.

## Why conflating them misleads

"It was 30 degrees" means one thing as an observation, another as a forecast, and another as a
thirty-year average for the date. A comparison that mixes classes without saying so — a forecast
against a baseline, presented as though both were measurements — reads as a fact when it is an
expectation set against a long-run average. Weathra labels each part of such an answer separately.
