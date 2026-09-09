"""The model lab: run one Weathra question across several models and record what differed.

An administrative tool with no privilege of its own. It selects only from the catalog
(`specs/model-catalog`), records through telemetry (`specs/llm-telemetry`), is accounted as
internal (`specs/usage-limits`), scores with the existing framework (`specs/evaluation`), and
changes nothing about production policy (`specs/model-lab`).

Two modules, split by what they are responsible for:

* ``compare.py`` — *running* a comparison: the bounds, the wall clock, the shared retrieval that
  makes an ad-hoc question fair across candidates, and the refusal of a selection outside the
  allowlist.
* ``records.py`` — *keeping* one: the run and its per-model-per-case results, with the provenance
  that makes two comparisons comparable at all.

**Why a package above `evaluation/` rather than inside it.** The evaluation framework answers "how
good is this build"; the lab answers "which of these models should serve". They share the dataset,
the metrics and the runner — the lab drives them rather than reimplementing them — but the lab also
has an initiating principal, an administrative surface, bounds, and an audit trail, none of which
belong to a CI-driven evaluation run. Keeping them apart keeps `evaluation/` runnable with no
database and no administrator, which is what CI needs.
"""

from __future__ import annotations

__all__: list[str] = []
