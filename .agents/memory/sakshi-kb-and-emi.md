---
name: Sakshi KB merge + EMI invariants
description: Two non-obvious rules in artifacts/api-server/src/lib/openai.ts that must never be regressed.
---

# KB merge invariant

`buildSystemPrompt()` must ALWAYS include `DEFAULT_HERO_KNOWLEDGE` (catalog, real on-road Jaipur prices, precomputed EMI table) and only *append* admin KB rows under an "[ADMIN KB OVERRIDES]" heading.

**Why:** A previous version used `knowledge || DEFAULT_HERO_KNOWLEDGE`. The moment the production admin KB had any row, it *replaced* the entire default catalog — silently nuking prices/EMI/model fixes. This was the real cause of "the agent never improves no matter what I ship." Tier-0 direct-answer call sites had the same bug.

**How to apply:** Never reintroduce `||` fallback between admin KB and the default. Default is the floor; admin is additive. Check every place that builds an LLM prompt or direct answer.

# Zero-arithmetic / EMI table

EMI numbers are precomputed server-side (`buildEmiTable`/`_emi`, EMI factors at 9% p.a.) across all variants × downs (₹20k/30k/50k) × tenures (12/18/24/36mo) and injected as "[PRECOMPUTED EMI TABLE]". The prompt has a ZERO-ARITHMETIC rule forbidding the LLM from computing — it must read the table verbatim.

**Why:** The LLM hallucinated EMIs badly (e.g. ₹50k down on a ₹1,04,555 bike → it said "₹2,750"; correct is ₹4,771). LLMs cannot be trusted with money math.

**How to apply:** If prices change, regenerate the table from the price list; do not let the LLM derive loan/EMI. Real prices live in DEFAULT_HERO_KNOWLEDGE (source: price_list spreadsheet).
