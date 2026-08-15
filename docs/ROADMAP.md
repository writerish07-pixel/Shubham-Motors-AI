# Shubham Motors AI — Product Map & Roadmap

**Product:** Sakshi, an Hindi/Hinglish voice sales agent plus dealership CRM  
**Dealership:** Shubham Motors — Hero MotoCorp, Jaipur  
**North-star question:** Does this help the dealership generate more revenue while improving the customer experience?

This document answers two things: what this repository actually is, and what to build next. It is grounded in the current codebase (June 2026 main), not a greenfield PRD. Existing modules are extended, never rewritten. Every new column stays nullable/defaulted; every new path stays additive and guarded.

Related docs:

- `docs/GROWTH_OS_V2.md` — Phase 1 audit + relationship/revenue intelligence increment
- `docs/PRODUCTION_HARDENING.md` — reliability, security, and scale-out findings
- `attached_assets/Shubham-Motors-AI-Audit-and-Fixes-Report_*.md` — June 2026 production-fix pass
- `.agents/memory/` — non-obvious invariants (KB merge, EMI math, outbound retry, lost-deal gating)

---

## 1. What this repo is

Sakshi is a **phone-first sales operating system** for one Hero dealership. A customer calls (or is called back). Sakshi greets them in Hindi, discovers what they want, quotes real Jaipur on-road prices and precomputed EMIs, books a test ride, and hands off to a human when needed. After the call, the system writes CRM fields, scores the relationship, schedules the next follow-up, and sends WhatsApp.

It is **not** a generic chatbot, a multi-tenant SaaS yet, or a full DMS. It is a working single-dealership stack: telephony + voice AI + CRM + auto-dialer + WhatsApp + a dealer dashboard.

### What a customer experiences

1. Inbound call to the Exotel virtual number, or an outbound follow-up from the auto-dialer.
2. Sakshi greets (personalized on outbound: last model discussed, last-call summary).
3. Discovery: segment (100cc / 125cc / 160cc+ / scooter / electric), style (sporty / family / commuter), budget, daily km, timeline, decision maker.
4. Catalog answers from the always-on Hero knowledge base (prices, stock, offers). EMI numbers come from a **precomputed table** — the LLM is forbidden from doing loan math.
5. CTA: test ride, showroom visit, buying timeline, or transfer to sales/finance.
6. After hang-up: WhatsApp summary + brochure, CRM update, follow-up scheduled (or cancelled if lost / DND / not interested).

### What the dealer sees

The React CRM (`artifacts/shubham-motors`) is the command center:

| Page | Job |
|------|-----|
| Dashboard | Lead/call stats, funnel, auto-dialer controls |
| Leads / Lead detail | Pipeline, Sakshi-learned fields, call now, schedule follow-up |
| Call logs | Transcripts, summaries, intent, WhatsApp-sent flag |
| Follow-ups | Pending/dialing/retry/WhatsApp-fallback queue |
| Campaigns | Filtered WhatsApp blasts |
| Knowledge | Admin KB (appends to the default catalog; never replaces it) |
| Settings | Admin token, sales/finance transfer contacts |

---

## 2. Architecture (as built)

```
Customer phone ──► Exotel (PSTN)
                     │ webhooks + WS audio (/call/stream)
                     ▼
              Express API (port 5000)
              ├── Voice pipeline
              │     STT (Sarvam → Whisper fallback, circuit breaker)
              │     → hybrid router / regex fast-path / KB direct-answer
              │     → OpenAI LLM (gpt-4o, 30s timeout)
              │     → TTS (Sarvam, ttsPrep pronunciation)
              │     → PCM back to Exotel
              ├── CRM + scheduler
              │     leads · calls · followups · campaigns · contacts
              │     callFinalize → relationshipIntel → WhatsApp
              └── Analytics API
                     dashboard · funnel · revenue-pipeline · relationships
                     │
                     ▼
              PostgreSQL (Drizzle)     WhatsApp via BotSpace
```

### Monorepo layout

| Path | Role |
|------|------|
| `artifacts/api-server` | Express 5 API, WebSocket voicebot, auto-dialer, integrations |
| `artifacts/shubham-motors` | React + Vite dealer CRM |
| `artifacts/mockup-sandbox` | UI sandbox (not production) |
| `lib/db` | Drizzle schema — **source of truth for data** |
| `lib/api-spec` | OpenAPI contract → Orval / Zod codegen |
| `lib/api-zod` | Generated request/response schemas |
| `lib/api-client-react` | Generated React Query hooks |

Stack: pnpm workspaces, Node 24, TypeScript 5.9, Express 5, PostgreSQL + Drizzle, Zod, OpenAI, Sarvam, Exotel, pino.

### Critical post-call path

Live calls persist through **one** module: `callFinalize.ts`. It analyzes the transcript, COALESCE-fills `interestedModel`, writes discovery fields, computes relationship/revenue scores, dedupes follow-ups, treats lost-deal / DND / not-interested as terminal, and sends WhatsApp. Do not reintroduce a second CRM write path (the June audit found WS vs webhook overwriting each other).

---

## 3. What is already shipped

Honest inventory. Items here are **done**; the roadmap below does not rebuild them.

### Voice & conversation

- Inbound + outbound Hindi/Hinglish voice on Exotel Voicebot WS
- Hybrid turn routing: regex fast-path, KB direct-answer, then LLM
- Thinking fillers chained (no audio overlap); latency-gated (~650 ms)
- Topic-interrupt on high-signal shifts only
- TTS pronunciation (Motors, Sakshi, cc, kmpl, markdown strip)
- STT circuit breaker + Whisper fallback; TTS simplified-Hindi retry
- Mid-call transfer to sales / finance contacts
- Style preference (`sporty` / family / commuter) in discovery
- DND (`doNotCall`) hard-gated on the dialer

### CRM & automation

- Phone-unique leads; import upsert; AND filters
- Unified post-call persistence (`callFinalize`)
- Buying-timeline-aware follow-up scheduling
- Auto-dialer with `pending → dialing → completed | pending | whatsapp_fallback`
- Attempt counting, stale-dialing reaper, IST callable window
- Outbound personalization via last-10-digit context map + ExoML `direction`
- WhatsApp: call summary, brochure, visit reminder, retry fallback
- Lost-deal fields + follow-up cancel (not just `status = lost`)
- Admin-token auth on `/api/*` (webhooks + `/healthz` public)

### Intelligence (backend)

Deterministic engine in `relationshipIntel.ts`, run after every call, no extra LLM cost:

| PRD phase | Columns / APIs |
|-----------|----------------|
| 3 Relationship | `relationshipScore`, `trustScore`, `engagementScore`, `loyaltyScore`, `followupScore` |
| 4 Purchase | `purchaseStage` (exploration → … → repeat) |
| 5 Sales | `purchaseProbability` |
| 11 Marketing | `customerPersona` |
| 13 Revenue | `expectedRevenue`, `lifetimeValue` |
| 16 Dashboard APIs | `/api/analytics/revenue-pipeline`, `/api/analytics/relationships` |

Plus competitor breakdown, buying-timeline mix, discovery coverage, retry stats, KB-pending counts, intent breakdown.

### Production hardening (utilities in place)

- `withRetry` / `withTimeout` on WhatsApp and Exotel
- OpenAI client timeout capped at 30s
- Constant-time admin-token compare
- `StageTimer` + `newTraceId` **implemented and unit-tested, not yet wired into `callStream.ts`**
- `/healthz`: DB ping, env flags, scheduler, STT circuit
- GitHub Actions: typecheck + api-server unit tests + build

### Current production-readiness snapshot

From `docs/PRODUCTION_HARDENING.md` (still accurate):

| Dimension | Score | Meaning |
|-----------|-------|---------|
| Reliability | 8.5 / 10 | Retries, timeouts, circuit breaker, fallbacks on the call path |
| Observability | 7 / 10 | Structured logs + unused stage timer; no APM sink |
| Security | 7.5 / 10 | Auth/secrets/redaction solid; webhooks unverified; no rate limit |
| Scalability | 6 / 10 | Single-instance; in-memory caches/circuit/outbound context |
| Maintainability | 8 / 10 | Clean monorepo; `callStream.ts` is a large hot-path file |
| **Overall** | **~7.4 / 10** | Production-capable as one instance; scale-out needs Redis |

---

## 4. Gaps that matter (do these before new PRD phases)

These are the highest-leverage unfinished pieces **of work already started**. They unblock dealer value and production safety more than new scoring columns.

### 4.1 Surface intelligence in the CRM (highest dealer value)

Scores and revenue APIs exist. The dashboard still charts the old funnel (`score`, status counts). Lead detail shows discovery fields (“What Sakshi Learned”) but **not** purchase stage, persona, relationship scores, probability, or expected revenue. OpenAPI (`lib/api-spec/openapi.yaml`) still only documents the original five analytics routes — so generated hooks never expose the new ones.

**Ship:**

1. Add `/analytics/revenue-pipeline`, `/analytics/relationships`, and the other live analytics routes to OpenAPI; regenerate Zod + React Query.
2. Dashboard: open pipeline ₹, expected vs lost revenue, persona mix, relationship bands (strong / warm / at-risk).
3. Lead detail: stage, persona, five scores, purchase probability, expected revenue / LTV — no `(lead as any)` casts.
4. Lead list: sort/filter by probability, stage, DND, visit booked.

Until this lands, Growth OS v2 is invisible to the people who would use it.

### 4.2 Wire observability into the live call path

`StageTimer` sits unused outside its unit tests. Wrap STT / routing / LLM / TTS / audio in `callStream.ts`, emit the per-turn `{ timing }` log, and persist a compact quality report on `calls` (p50 target: full turn **< 3s**). This is the cheapest way to start Phase 14 (voice quality) and to catch TTS/STT regressions without listening to every recording.

### 4.3 Contract drift

Runtime routes have grown past the OpenAPI spec (analytics extras, scheduler, campaigns, contacts, webhooks). Frontend sometimes bypasses generated clients (`fetch` to `/api/scheduler/*`). Treat OpenAPI as the contract again: spec first, then codegen, then UI.

### 4.4 Production safety leftovers

| Item | Why it still matters |
|------|----------------------|
| Exotel webhook IP allowlist / shared-secret param | Public `/webhooks/*` can spoof call status and fire retries / WhatsApp |
| Rate limit webhooks + outbound dial | Abuse and accidental scheduler storms |
| Versioned SQL migrations (not only `drizzle-kit push`) | No rollback; schema drift across envs; a missing column has already caused silent dead-air in prod |
| FK + cascade on `calls.lead_id`, `followups.lead_id` | Orphan rows on lead delete |
| Redis for circuit, KB cache, outbound context, phrase cache | Required before a second instance |

---

## 5. Roadmap — ordered work

Order is **value and risk**, not calendar. Stay additive. Preserve every existing API and workflow.

### Now — make shipped intelligence usable and the call path measurable

1. **CRM intelligence UI + OpenAPI sync** (§4.1, §4.3). Dealer-visible Growth OS.
2. **Wire `StageTimer` through `callStream`** and persist a per-call timing/quality blob (§4.2).
3. **Exotel webhook verification** (IP allowlist and/or shared secret).
4. **Rate limiting** on webhooks and outbound dial.

Exit criteria: a GM can open the dashboard and see pipeline ₹ and at-risk relationships; a live call emits per-stage timings; spoofed webhooks are rejected.

### Next — remaining Growth OS product phases

Build on columns and scores that already exist. Do not duplicate them.

5. **Phase 2 — Customer Intelligence**  
   Promote the richest lead fields into a `customer_profiles` view/table keyed by normalized phone. Persist conversation summaries and a short emotion/intent history so Sakshi never re-asks across calls (partially true today via lead columns; this makes it a first-class customer, not a lead row).

6. **Phase 12 — Predictive follow-up**  
   `buyingTimeline` + `resolveFollowupSchedule` already pick a date. Use `followupScore` (and preferred call window / DND) to tighten cadence: high-responsiveness + immediate timeline → denser calls; low follow-up score → WhatsApp-first.

7. **Phase 6 — Future Opportunity Engine**  
   From persona + LTV + current vehicle: second bike for family, insurance renewal, service due, accessories, festival upgrade. Write `opportunities` rows; let campaigns target them. No extra LLM required for the first version — rules on existing columns.

8. **Phase 7 — Competitor win/loss database**  
   `/analytics/competitor-breakdown` is a GROUP BY. Persist structured win/loss events (`lostToBrand`, `lostReason`, `lostOfferFactor`) and a simple “what we offered vs what they bought” view for the GM.

9. **Phase 10 — Conversation intelligence**  
   Per-call self-critique stored on `calls` (same pure-function pattern as `relationshipIntel`): did we ask a CTA, answer the question, talk over the customer, miss a transfer. Feeds voice-quality monitoring.

10. **Phase 8/9 — Self-learning & knowledge versioning**  
    `learnFromTranscript` already queues review rows (`[agent_mistake]`, `[price_correction]`, …). Add effective-date versioning on KB documents, keep `DEFAULT_HERO_KNOWLEDGE` as the immutable floor, and never let admin KB replace the catalog (`||` fallback is a known regression).

### Then — enterprise architecture (Phase 14–15)

11. **Versioned Drizzle migrations** before any second environment.
12. **Redis** for shared state (circuit breaker, outbound context, caches). Unlocks horizontal scale.
13. **OpenTelemetry** using the trace IDs already added; ship timings to an APM.
14. **Load / concurrent-call harness** (simulated WS audio, not a live PSTN bill).
15. **FK constraints + cascade**; remove the legacy Record webhook path once unused.
16. **Personalized greeting PCM cache** for outbound (latency; names still go through `prepareNameForTts`).
17. Opportunistic split of `callStream.ts` (~1300 lines) **only** when a change already requires touching the turn loop — not a standalone rewrite.

### Later / only when the single-rooftop loop is proven

- Multi-dealership / multi-tenant (org_id, per-dealer KB, per-dealer Exotel numbers)
- True two-way WhatsApp bot (campaigns are one-way today)
- Human-in-the-loop live assist (whisper to the agent, not just transfer)
- Price-list admin workflow with dated catalogs and an on-call disclaimer
- RBAC beyond a single `ADMIN_TOKEN` (GM vs telecaller vs KB editor)

---

## 6. Suggested sequencing (dependency view)

```
OpenAPI + CRM UI ─────────────────────────────► dealer actually uses scores
        │
StageTimer in callStream ──► persist quality on calls ──► Phase 10 + APM
        │
Webhook verify + rate limit ──► safe to scale dialer
        │
Migrations ──► FK/cascade ──► Redis ──► second instance
        │
Phase 2 profiles ──► Phase 12 cadence ──► Phase 6 opportunities ──► campaigns
        │
Competitor events (7) and KB versioning (8/9) can proceed in parallel
        │
Multi-tenant only after Redis + migrations + proven single-rooftop metrics
```

---

## 7. Invariants — do not regress

These have already caused silent production failures. Any roadmap item that touches the listed files must keep them.

| Invariant | Where | Failure mode |
|-----------|--------|----------------|
| `DEFAULT_HERO_KNOWLEDGE` always in the prompt; admin KB **appends** | `openai.ts` | Agent “never improves”; prices/EMI vanish |
| LLM never computes EMI; read the precomputed table | `openai.ts`, `emiQuote.ts` | Hallucinated loan quotes |
| Thinking fillers chained via `playChain = fillerDone` | `callStream.ts` | Overlapping garbled audio |
| Lost-deal **and** terminal intent cancel follow-ups | `callFinalize.ts` | Dialing customers who already bought elsewhere |
| `interestedModel` is COALESCE-fill only | `callFinalize` / status webhook | Confirmed model clobbered by a noisy inference |
| Outbound `direction` Parameter + last-10 phone key | ExoML + `scheduler` / `callStream` | Every callback sounds like a cold inbound |
| Follow-up claim/resolver single-owner | `scheduler.ts` | Duplicate dials and double WhatsApp |
| Unknown Exotel status → non-terminal (`in_progress`) | `webhooks.ts` | Premature retry of a live call |
| New Drizzle column → `db push` (dev) then republish | schema | Silent dead-air: lead SELECT throws before greeting |
| Never wholesale-copy an uploaded `_v3` fork | voice pipeline | Lose KB merge / EMI / fillers |

Full write-ups: `.agents/memory/`.

---

## 8. How we will know it is working

Dealer outcomes, not model scores:

| Signal | Why |
|--------|-----|
| Speed-to-lead (inbound → first Sakshi turn, and inbound → first human if transferred) | Missed calls are lost Hero sales |
| Visit booked / visit showed | Test-ride is the conversion event |
| Follow-up connect rate vs WhatsApp-fallback rate | Auto-dialer quality |
| Open pipeline ₹ and conversion vs `purchaseProbability` | Whether scores are calibrated |
| Lost-deal capture (brand + reason filled) | Pricing and offer feedback |
| p50 turn latency < 3s; barge-in works; no filler overlap | Voice quality the customer feels |
| Zero DND/lost-deal outbound dials | Compliance and brand |

Instrument these on the dashboard once §4.1 ships. Do not add new intelligence columns until the existing ones are visible and trusted.

---

## 9. Explicit non-goals

- Rebuilding the voice pipeline, CRM, or schema from scratch
- Letting the LLM do money math
- Replacing `DEFAULT_HERO_KNOWLEDGE` with whatever is in the admin KB
- Multi-instance deploy before Redis + migrations
- Pushing DDL to production outside the existing publish/`db push` workflow
- Expanding to other OEMs/dealerships before the Hero Jaipur loop is measurable

---

## 10. First implementation slice (when coding starts)

If the next change is a single PR, make it this:

**“Show the Growth OS in the CRM.”**

1. Document the live analytics routes and new lead columns in `openapi.yaml`.
2. `pnpm --filter @workspace/api-spec run codegen`.
3. Dashboard cards for open pipeline, committed revenue, relationship bands, persona mix.
4. Lead detail: stage, persona, scores, probability, expected revenue — typed, no `as any`.
5. Leave scoring math untouched (`relationshipIntel.ts` already has tests).

That slice needs no schema push, no telephony change, and no new LLM cost. It is the missing last mile of work that is already in `main`.
