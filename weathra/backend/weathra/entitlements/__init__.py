"""The stores behind the model policy layer: the catalog, the policies, and the plans.

This package is data access and administration, and deliberately not resolution. It answers "what
models exist, what may each policy pick from, and what does each plan map to" — the resolver that
turns a principal and a call role into one model sits above it (`specs/model-policy`, group 28) and
reads only through here.

Keeping the two apart is what stops model selection from spreading. A node that wanted to pick a
model would have to reach past a resolver it does not import, into a store whose read API returns
catalog *keys* rather than gateway strings, and the vendor-identifier confinement test would fail
on it. That is three obstacles rather than a rule in a document.
"""
