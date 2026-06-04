---
name: Sakshi CRM-field persistence from call analysis
description: Rules for writing LLM-inferred CRM fields onto a lead in the status webhook without clobbering stronger data.
---

# CRM-field persistence from analyzeCallIntent

When `/webhooks/exotel/status` analyzes a completed call, it persists inferred CRM
fields onto the lead (familyInfo, competitorMentioned/Reason, buyingTimeline, and
the model the caller wants).

## Rule: never clobber `interestedModel` with an LLM inference
`interestedModel` must only be **filled when empty**, not overwritten. The update
uses `COALESCE(leads.interested_model, <inferred>)` so an existing value (manually
set by sales, or a previously confirmed model) always wins over a weaker per-call
inference (`analysis.preferredModel`).

**Why:** `interestedModel` drives downstream actions — brochure selection and the
sales follow-up context. A noisy single-call inference overwriting a confirmed
model misdirects both. Other CRM fields (familyInfo, competitor*, buyingTimeline)
are last-write-wins by design; only `interestedModel` is protected.

**How to apply:** if you add more "source of truth"-style lead fields, prefer the
same COALESCE-fill pattern rather than unconditional set when the source is an LLM
inference.
