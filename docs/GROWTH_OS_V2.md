# AI Dealership Growth OS — Production Upgrade v2

**Project:** Shubham-Motors-AI ("Sakshi" voice agent)
**Dealership:** Shubham Motors — Hero MotoCorp, Jaipur
**Scope of this document:** Phase 1 audit of the existing system + the first
production-grade increment of the Growth OS v2 PRD, delivered with full
backward compatibility.

> This upgrade follows the PRD's ABSOLUTE RULES: **do not rebuild, extend the
> existing modules, preserve every existing API and workflow, keep CRM data
> compatible.** Nothing in this increment removes or rewrites a working module.
> Every new column is nullable/defaulted; every new code path is additive and
> guarded so a failure can never block an existing call, CRM write, or WhatsApp.

---

## 1. Phase 1 — Codebase Audit

### 1.1 Architecture (as-is)

A healthy pnpm + TypeScript monorepo. Nothing here needs a rewrite.

| Layer | Location | Stack |
|-------|----------|-------|
| API server | `artifacts/api-server` | Express 5, `ws`, OpenAI, Sarvam STT/TTS, Exotel, Drizzle |
| Web CRM | `artifacts/shubham-motors` | React + Vite |
| Mockup sandbox | `artifacts/mockup-sandbox` | React |
| DB schema | `lib/db` | Drizzle ORM + PostgreSQL |
| API contracts | `lib/api-spec`, `lib/api-zod`, `lib/api-client-react` | OpenAPI + Orval + Zod |

The voice pipeline (`callStream.ts`), per-call analysis (`openai.ts`), unified
post-call persistence (`callFinalize.ts`), auto-dialer (`scheduler.ts`),
knowledge base, and WhatsApp integration are all functional and were hardened in
the June 2026 audit pass (`attached_assets/Shubham-Motors-AI-Audit-and-Fixes-Report*.md`).

### 1.2 Health of the codebase

- **Typecheck:** clean across all 4 buildable projects (`pnpm run typecheck`).
- **Tests:** present and passing (`node:test` via `run-tests.mjs`).
- **Dead code / circular imports / missing imports:** none blocking — the prior
  audit removed the critical defects (broken transfer URL, doubled webhook URL,
  open API auth, split CRM persistence, lost call data, duplicate follow-ups).
- **CRM intelligence foundation already exists** on `leads` (familyInfo,
  currentVehicle, segment, budget, dailyKm, competitor fields, buyingTimeline,
  decisionMaker, lost-deal fields, DND, visit scheduling). This increment builds
  on that foundation rather than duplicating it.

### 1.3 Carry-over recommendations (from prior audit, still open)

These remain the right next infrastructure investments (PRD Phase 15) and are
**not** regressed by this change: Redis for multi-instance shared state,
versioned SQL migrations (vs `drizzle-kit push`), Exotel webhook signature
verification, rate limiting, per-turn latency metrics/APM, and FK + cascade
constraints on `calls.lead_id` / `followups.lead_id`.

---

## 2. What this increment delivers

The highest-leverage, lowest-risk slice of the PRD: turn the existing **lead**
CRM into a **relationship + revenue** CRM. This touches the PRD vision directly
while staying additive.

### 2.1 PRD phases covered

| PRD Phase | Delivered here |
|-----------|----------------|
| **3 — Relationship Intelligence** | Trust / Engagement / Relationship / Loyalty / Follow-up scores on every lead, recomputed after each call. |
| **4 — Purchase Intelligence** | `purchaseStage`: exploration → comparison → evaluation → ready → negotiation (+ repeat for returning owners). |
| **5 — Sales Intelligence** | `purchaseProbability` derived from intent + timeline + readiness signals. |
| **11 — Marketing Intelligence** | `customerPersona`: price / mileage / family / business / performance / status / comfort / value buyer. |
| **13 — Revenue Engine** | `expectedRevenue` (probability-weighted) and `lifetimeValue` (vehicle + finance + insurance + service + accessories + referral + future upgrade). |
| **16 — Management Dashboard** | `/api/analytics/revenue-pipeline` and `/api/analytics/relationships` endpoints. |

### 2.2 New / changed files

| File | Change |
|------|--------|
| `lib/db/src/schema/leads.ts` | **+11 additive columns** (all nullable/defaulted): `purchaseStage`, `customerPersona`, `relationshipScore`, `trustScore`, `engagementScore`, `loyaltyScore`, `followupScore`, `purchaseProbability`, `expectedRevenue`, `lifetimeValue`, `intelligenceUpdatedAt`. |
| `artifacts/api-server/src/lib/relationshipIntel.ts` | **New.** Pure, deterministic, zero-dependency scoring engine. No DB / network / LLM / clock. |
| `artifacts/api-server/src/lib/callFinalize.ts` | Wires the engine into the existing post-call path; spreads the score patch into the existing `leads` update. Fully guarded — a compute failure logs and skips, never blocks. |
| `artifacts/api-server/src/routes/analytics.ts` | **+2 read-only dashboard endpoints** for revenue pipeline and relationship/persona mix. |
| `artifacts/api-server/test/relationshipIntel.test.ts` | **New.** 7 unit tests for stage, persona, probability, revenue, and the composite patch. |

### 2.3 Why it's safe

- The scoring engine is **pure and deterministic** — same input always yields the
  same output, so it is cheap to call after every call and trivial to test.
- It reuses data `callFinalize` already computes (call analysis + discovery
  signals + call history). **No extra LLM/API cost.**
- All DB columns are nullable or defaulted, so existing leads and the auto-dialer
  keep working with no backfill required.
- The compute is wrapped in try/catch; failure logs and continues to the CRM
  write and customer WhatsApp.

### 2.4 How scores are derived (deterministic)

- **Engagement** ← number of completed calls, visit booked, finance/exchange
  interest, questions asked.
- **Trust** ← repeated contact + showroom commitment build it; unresolved
  objections and competitor shopping erode it; capped low on a lost deal.
- **Loyalty** ← existing Hero ownership and prior conversion dominate.
- **Follow-up** ← responsiveness across calls and a near-term buying timeline.
- **Relationship** ← weighted composite (0.35 trust, 0.30 engagement, 0.20
  loyalty, 0.15 follow-up).
- **Purchase probability** ← anchored on the call's buying-intent score, adjusted
  by timeline (immediate +12 … next_year −15), readiness, negotiation, visit;
  zeroed on lost / wrong-number.
- **Expected revenue** ← model on-road price (or segment estimate) × probability.
- **Lifetime value** ← vehicle + finance margin + 5-yr insurance + 5-yr service +
  accessories + referral potential + future-upgrade potential.

---

## 3. Deployment

This increment adds DB columns, so after deploy run the schema push (same
workflow the project already uses):

```bash
pnpm --filter @workspace/db run push
```

No data backfill is required — scores populate as calls complete. Existing
`/api/analytics/*` endpoints are unchanged; the two new ones return zeros until
calls land, which is correct.

Verify:

```bash
pnpm run typecheck            # clean
pnpm --filter @workspace/api-server test   # relationshipIntel + existing suites pass
```

---

## 4. Roadmap — remaining PRD phases

The living product map is **`docs/ROADMAP.md`**. The August 2026 market +
macro/micro production-grade audit is **`docs/PRODUCTION_AUDIT.md`**. The
remaining phases below build naturally on this foundation. Suggested order:

1. **Phase 2 — Customer Intelligence Engine:** promote the richest fields into a
   dedicated `customer_profiles` view/table keyed by phone; persist conversation
   summaries and emotion history (the scores added here are the spine of this).
2. **Phase 6 — Future Opportunity Engine:** derive cross-sell opportunities
   (family/second vehicle, insurance renewal, service, accessories) from the
   persona + lifetime-value columns now available.
3. **Phase 7 — Competitor Intelligence:** extend the existing
   `competitor-breakdown` analytics into a win/loss intelligence database.
4. **Phase 8/9 — Self-Learning & Knowledge Engine:** version uploaded documents
   by effective date; the `learnFromTranscript` hook already exists to extend.
5. **Phase 10 — Conversation Intelligence:** per-call self-critique scores stored
   on `calls`, reusing the deterministic-scoring pattern established here.
6. **Phase 12 — Predictive Follow-up:** already partially present
   (`buyingTimeline`, `resolveFollowupSchedule`); extend with the new
   follow-up-responsiveness score to tune cadence.
7. **Phase 14 — Voice AI Quality** and **Phase 15 — Enterprise Architecture:**
   the carry-over infra items in §1.3.

Every step answers the PRD's one question: *does it help the dealership generate
more revenue while improving customer experience?*
