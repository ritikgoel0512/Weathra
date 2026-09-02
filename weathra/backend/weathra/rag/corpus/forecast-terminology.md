---
id: forecast-terminology
title: Weather model and forecast terminology
topic: terminology
provenance: >
  Written for Weathra from standard numerical weather prediction terminology. Explanatory only;
  contains no measurements for any location.
---

# Weather model and forecast terminology

## Numerical weather prediction

A weather model divides the atmosphere into a three-dimensional grid and steps the equations of
fluid motion, thermodynamics, and moisture forward in time. Everything a modern forecast says comes
out of that process, started from an analysis of current observations.

**Resolution** is the grid spacing. A global model might run at ten to twenty kilometres; a regional
model at one to three. Resolution sets what a model can represent at all: an individual
thunderstorm is smaller than a global model's grid box, so such a model can only describe the
conditions that favour storms, not the storms themselves.

**Parametrisation** is how a model handles processes too small to resolve — cloud droplet
formation, turbulence, convection. These are approximations, and they are the main source of
model-to-model difference in precipitation.

## Model runs and cycles

A model runs on a **cycle**, typically every six or twelve hours, each starting from a fresh
analysis. The **run time** (or initialisation) is when the cycle started; **lead time** is how far
ahead a particular figure looks. Two forecasts for the same afternoon from consecutive cycles will
differ slightly, and comparing them is what "the forecast has changed" actually means.

## Analysis and reanalysis

An **analysis** is the model's best estimate of the atmosphere's current state, blending
observations with a previous forecast. A **reanalysis** is the same process applied retrospectively
across decades with one consistent model, which is what makes long historical archives comparable
over time. Reanalysis is not the same as raw observations: it is a physically consistent estimate
informed by them, and it necessarily runs some days behind the present.

## Deterministic and probabilistic

A **deterministic** forecast is a single model run: one value per time and place. A **probabilistic**
or **ensemble** forecast is many runs, describing a distribution. A single deterministic value is
one plausible outcome, not the most likely one and not an average.

## Nowcast

A **nowcast** covers the next few hours and works differently: it extrapolates radar and satellite
observations rather than running the full model, because over short ranges observing where rain is
now and where it is moving beats simulating the atmosphere.
