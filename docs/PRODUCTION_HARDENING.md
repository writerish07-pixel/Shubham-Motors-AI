# Production Hardening Report — AI Dealership Growth OS

**System:** Shubham-Motors-AI ("Sakshi" voice agent)
**Lens:** Principal Engineer / Enterprise Architect / SRE / Security / QA
**Mandate:** harden the existing platform for production. No redesign, no
rewrites of working modules — extend and improve only. Every change is additive
and backward-compatible.

This document is the consolidated deliverable: it contains all ten required
artefacts (audit, benchmarks, security, tech-debt, code quality, readiness
score, risk register, roadmap, architecture diagram, and the change log).

---

## 0. What changed in this pass (Deliverable #10 — change log)

All changes are additive; no existing API, route, schema column, or workflow was
removed or altered in a breaking way. Typecheck clean; 43 unit tests pass.

| Area | File | Change |
|------|------|--------|
| Reliability (P2) | `lib/resilience.ts` *(new)* | `withRetry` (exponential backoff + full jitter), `isRetryableError` (5xx/429/network only), `withTimeout`. Pure, dependency-free, unit-tested. |
| Reliability (P2) | `lib/whatsapp.ts` | Both sends wrapped in `withRetry`; secrets now read at call time (was a stale module-load snapshot). |
| Reliability (P2) | `lib/exotel.ts` | Outbound dial + mid-call transfer wrapped in `withRetry` (transfer uses fast, short backoff so the customer isn't left on hold). |
| Reliability (P2) | `lib/openai.ts` | OpenAI client `timeout` capped at 30s (SDK default is **600s** — a hang would freeze a live call) + explicit `maxRetries`, both env-configurable. |
| Observability (P3/P4) | `lib/observability.ts` *(new)* | `newTraceId()` + `StageTimer` for per-stage pipeline latency (STT/routing/LLM/TTS/audio) and a machine-readable per-turn timing report. Unit-tested. |
| Security (P9) | `middlewares/auth.ts` | Admin-token check is now **constant-time** (`timingSafeEqual`) — closes a token-timing side channel. |
| Observability (P3) | `routes/health.ts` | `/healthz` now reports `uptimeSec`, `version`, and OpenAI/WhatsApp env presence. |
| Testing (P12) | `test/resilience.test.ts`, `test/observability.test.ts` *(new)* | 11 new unit tests (retry classification, backoff bounds, retry/exhaustion, timeout, stage timing). |
| Testing (P12) | `run-tests.mjs` | Externalised pino so logger-backed modules are testable; tests run with `NODE_ENV=production`/silent logs. |

---

## 1. Production Audit (Deliverable #1)

### Architecture

pnpm + TypeScript monorepo. Clean separation; no rewrite warranted.

```
lib/db ........... Drizzle schema (Postgres)        — source of truth for data
lib/api-spec ..... OpenAPI contract → Orval/Zod codegen
artifacts/api-server ... Express 5 API + WebSocket voice pipeline
artifacts/shubham-motors ... React CRM dashboard
```

Voice pipeline: Exotel telephony → WS audio → Sarvam STT (Whisper fallback) →
hybrid router/fast-path → OpenAI LLM → Sarvam TTS → audio back. Post-call:
unified `callFinalize` → CRM persistence, WhatsApp summary/brochure, follow-up
scheduling, self-learning, and (v2) relationship/revenue intelligence.

### Reliability — findings

| # | Finding | Before | Status |
|---|---------|--------|--------|
| R1 | STT resilience | Circuit breaker + Whisper fallback + keepAlive | ✅ already strong |
| R2 | WhatsApp / Exotel transient failures | timeout + log, **no retry** | ✅ `withRetry` added |
| R3 | OpenAI request timeout | SDK default 600s | ✅ capped to 30s |
| R4 | WhatsApp secret rotation | read at module load (stale) | ✅ read at call time |
| R5 | In-call STT/TTS retries | none (by design) | ✅ left as-is — retrying mid-loop would blow the latency budget; circuit breaker + fallback is the correct pattern here |

### API health

All external integrations have explicit timeouts. After this pass all
non-latency-critical calls also have bounded retries. `/healthz` does a live DB
ping, surfaces env wiring, scheduler state, and the STT circuit state.

### Dependency health

Lean, current majors (Express 5, OpenAI 6, Drizzle, pino 9, axios 1, ws 8).
pnpm catalog pins shared versions. No deprecated runtime deps observed.

---

## 2. Performance Benchmark Report (Deliverable #2)

The pipeline already carries latency-aware engineering: keepAlive TCP agents to
Sarvam, tight per-stage timeouts (STT 6s / TTS 5s / LID 3s), TTS generated at
22.05 kHz then resampled, a regex fast-path that skips the LLM for common turns,
and a 5-min KB cache with explicit invalidation.

**Gap closed:** there was no *structured* per-stage timing. `StageTimer`
(`lib/observability.ts`) now provides it. Target budget to track per turn:

| Stage | Target p50 | Instrument |
|-------|-----------|------------|
| STT | < 800 ms | `timer.time("stt", …, via)` |
| Routing + KB | < 50 ms | `timer.time("routing"/"knowledge", …)` |
| LLM | < 1200 ms | `timer.time("llm", …)` |
| TTS | < 900 ms | `timer.time("tts", …, via)` |
| **Total turn** | **< 3000 ms** | `timer.report()` |

`report()` emits one structured `{ timing: … }` log per turn — ready to ship to
any log/metrics backend without further code changes.

---

## 3. Security Audit Report (Deliverable #3)

| # | Item | Finding | Status |
|---|------|---------|--------|
| S1 | Admin token comparison | non-constant-time `!==` (timing side channel) | ✅ fixed (`timingSafeEqual`) |
| S2 | API authn | global `requireApiAuth` on `/api/*`; only `/healthz` + `/webhooks/*` public | ✅ correct |
| S3 | Secrets | all from env, never logged; pino redacts auth/cookie headers | ✅ |
| S4 | CORS | env-driven allowlist with credentials | ✅ |
| S5 | Body limits | 25 MB only on KB import, default elsewhere | ✅ |
| S6 | Exotel webhooks | **no signature/IP verification** (public by necessity) | ⚠️ open — add IP allowlist / shared-secret param (roadmap) |
| S7 | Rate limiting | none on webhooks/outbound dial | ⚠️ open (roadmap) |
| S8 | Prompt injection | KB content feeds the LLM prompt; KB CRUD is admin-gated | ⚠️ monitor — treat KB as trusted-admin only |

---

## 4. Technical Debt Report (Deliverable #4)

| Item | Severity | Note |
|------|----------|------|
| `callStream.ts` is ~1300 lines | Medium | Works and is hot-path; refactor opportunistically, not now. `StageTimer` is designed to drop in without restructuring it. |
| Schema uses `drizzle-kit push`, no versioned migrations | Medium | Add migration history before multi-env rollout. |
| In-memory state (caches, circuit, outbound context) | Medium | Blocks horizontal scale → needs Redis (roadmap). |
| No FK / cascade on `calls.lead_id`, `followups.lead_id` | Low | Indexed already; add constraints with a migration. |
| Legacy Record webhook path retained | Low | Backward-compat; remove once unused. |

---

## 5. Code Quality Report (Deliverable #5)

- Typecheck: **clean** across all 4 build targets (`pnpm run typecheck`).
- Tests: **43 passing** (`pnpm --filter @workspace/api-server test`).
- New modules are pure, dependency-free, and fully unit-tested.
- No dead code / unused deps introduced; no breaking edits. New external-call
  paths preserve every caller's existing try/catch + graceful-fallback contract
  (`withRetry` re-throws the last error after exhausting attempts).

---

## 6. Production Readiness Score (Deliverable #6)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Reliability | 8.5 / 10 | retries + timeouts + circuit breaker + fallbacks everywhere on the call path |
| Observability | 7 / 10 | structured logs + trace IDs + stage timing utility; wiring into callStream + a metrics sink still pending |
| Security | 7.5 / 10 | strong authn/secrets/redaction; webhook verification + rate limiting open |
| Scalability | 6 / 10 | single-instance due to in-memory state; Redis unlocks horizontal scale |
| Maintainability | 8 / 10 | clean monorepo, typed, tested; one large hot-path file |
| **Overall** | **7.4 / 10 — production-capable single-instance; scale-out needs Redis** | |

---

## 7. Risk Register (Deliverable #7)

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| RK1 | Sarvam outage mid-call | Med | High | ✅ circuit breaker + Whisper fallback |
| RK2 | Transient WhatsApp/Exotel failure drops follow-up/dial | Med | Med | ✅ `withRetry` |
| RK3 | LLM hang freezes a live call | Low | High | ✅ 30s client timeout |
| RK4 | Unverified Exotel webhook spoofing | Low | High | ⚠️ add IP allowlist / shared secret |
| RK5 | Horizontal scale corrupts in-memory state | Med (at scale) | High | ⚠️ Redis for shared state |
| RK6 | Schema drift without migrations | Med | Med | ⚠️ versioned migrations |
| RK7 | Admin token brute force / timing | Low | High | ✅ constant-time compare; add rate limiting |

---

## 8. Prioritized Improvement Roadmap (Deliverable #8)

**Now (this pass):** ✅ retries/backoff, OpenAI timeout, constant-time auth,
trace-ID + stage-timing utilities, richer health, tests.

**Next (1–2 sprints):**
1. Wire `StageTimer` through `callStream.ts` turns; persist the per-call quality
   report (enables Phase 4 voice-quality monitoring).
2. Exotel webhook hardening (IP allowlist / shared-secret custom param).
3. Rate limiting on webhooks + outbound dial.
4. Versioned SQL migrations.

**Then (scale-out):**
5. Redis for circuit state, caches, outbound context, phrase cache.
6. Metrics/trace export (OpenTelemetry → APM) using the IDs added here.
7. Load + concurrent-call test harness; FK + cascade constraints.

---

## 9. Enterprise Architecture Diagram (Deliverable #9)

```
                         ┌──────────────────────────┐
   Customer phone ──────▶│        Exotel (PSTN)      │
                         └────────────┬──────────────┘
                  webhooks / WS audio │  (retry-wrapped outbound + transfer)
                         ┌────────────▼──────────────┐
                         │   Express API (api-server) │
                         │  authn (constant-time) ·   │
                         │  pino logs + trace IDs     │
                         └──┬───────┬───────┬─────────┘
            ┌───────────────┘       │       └───────────────┐
   ┌────────▼────────┐   ┌──────────▼─────────┐   ┌──────────▼─────────┐
   │ Voice pipeline  │   │  CRM / scheduler   │   │   Analytics API    │
   │ STT(Sarvam→     │   │  leads · calls ·   │   │ dashboards · revenue│
   │   Whisper, CB)  │   │  followups ·       │   │ · relationships    │
   │ → router/fast   │   │  callFinalize →    │   └─────────┬──────────┘
   │ → LLM(OpenAI,   │   │  relationshipIntel │             │
   │   30s timeout)  │   └──────────┬─────────┘             │
   │ → TTS(Sarvam)   │              │                       │
   │  [StageTimer]   │   WhatsApp (retry) ◀── BotSpace      │
   └────────┬────────┘              │                       │
            └──────────────┬────────┴───────────────────────┘
                  ┌────────▼────────┐
                  │  PostgreSQL      │  (Drizzle; indexed)
                  └──────────────────┘
```

---

## 10. Verification

```bash
pnpm run typecheck                          # clean (all 4 projects)
pnpm --filter @workspace/api-server test    # 43 passing
```

No DB schema change in this pass, so no `db push` required for these hardening
changes. New env knobs (all optional, with safe defaults):
`OPENAI_TIMEOUT_MS` (30000), `OPENAI_MAX_RETRIES` (2), `APP_VERSION`.
