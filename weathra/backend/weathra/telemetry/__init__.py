"""What every language model call cost, in tokens, money and time — and whether it worked.

The measurement substrate under model policy, quota enforcement and model comparison. It records
*what happened*; it decides nothing. The resolver above it (`entitlements/resolver.py`) chose the
model, the run recorded the attempt, and this package projects those recorded facts onto rows.

That direction is the whole architecture, and it is worth stating because the tempting alternative
is subtly wrong: telemetry that re-derived the plan, the policy or the model from current state
would describe *the decision it would make now* rather than the decision that actually happened.
Catalog and policy state change; a usage event written last Tuesday must still say what served the
call last Tuesday.
"""
