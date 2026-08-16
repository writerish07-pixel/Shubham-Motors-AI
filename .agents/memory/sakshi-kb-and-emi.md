---
name: Sakshi KB merge + EMI invariants
description: Two non-obvious rules in artifacts/api-server/src/lib/openai.ts that must never be regressed.
---

# KB merge invariant

`buildSystemPrompt()` must ALWAYS include `DEFAULT_HERO_KNOWLEDGE` (catalog, real on-road Jaipur prices, live EMI instructions) and only *append* admin KB rows under an "[ADMIN KB OVERRIDES]" heading.

**Why:** A previous version used `knowledge || DEFAULT_HERO_KNOWLEDGE`. The moment the production admin KB had any row, it *replaced* the entire default catalog — silently nuking prices/EMI/model fixes.

**How to apply:** Never reintroduce `||` fallback between admin KB and the default. Default is the floor; admin is additive.

# Live EMI (server-side, not a table)

EMI rupees are calculated live in `emiQuote.ts`. The LLM tags `[EMI:Model|down|months]`. Do not inject `[PRECOMPUTED EMI TABLE]`.

The CRM Knowledge → Playbook tab is the `knowledge` table. `syncCanonicalKnowledge()` runs on API boot and rewrites leftover seed cards (including **"EMI without math"**). After deploy, open `/api/regress` in a browser — every check should be `ok: true`.

**How to apply:** Prices live in `heroCatalog.ts`. Never re-seed a playbook that says "Kabhi calculate mat karo".
