# Production-Grade Audit — Macro, Micro, and Market Gap

**System:** Shubham-Motors-AI (“Sakshi”)  
**Date:** 15 August 2026  
**Lens:** What the best voice agents in market actually ship in 2026, vs what this repo ships, vs what “final production grade” requires for a Hero dealership in India.

This is a **read-only audit**. It does not change runtime behaviour. It supersedes informal “remaining recommendations” lists by scoring against an external market bar, not only against our own earlier PRs.

Companion docs: `docs/ROADMAP.md` (what to build), `docs/GROWTH_OS_V2.md` (intelligence increment), `docs/PRODUCTION_HARDENING.md` (June reliability pass).

---

## 0. Executive verdict

Sakshi is a **strong vertical product on a mid-tier voice stack**.

The dealership OS — Hindi sales craft, Jaipur on-road prices, zero-arithmetic EMI, CRM memory across calls, auto-dialer retries, lost-deal capture, DND flag, speed-to-lead — is ahead of generic platforms (Vapi / Retell / Bland) for *this* rooftop. Those platforms will not know that “125” means CC not a model, or that `interestedModel` must never be clobbered by a noisy LLM guess.

The **voice transport** is behind 2026 production grade. Market leaders target **500–800 ms** end-to-end turn gap. This codebase documents a **< 3 000 ms** budget and uses a **batch** STT → LLM → **batch** TTS cascade. Barge-in exists but is energy-threshold, not a VAD + echo-cancel + history-truncate stack. Observability, webhook auth, TRAI/NCPR scrub, WhatsApp DLT templates, and live CRM intelligence UI are incomplete.

**Do not rebuild on Vapi/Retell.** That would throw away the only moat. Close the P0/P1 gaps below until a Jaipur customer cannot tell Sakshi from a good human BDC, and a GM can see pipeline ₹ without opening SQL.

**Production-grade score (this pass): 6.4 / 10** as a live single-rooftop agent; **4.5 / 10** against the 2026 market voice bar. Previous hardening scored 7.4 on *reliability of the current architecture*. This audit scores *fitness vs what buyers now expect*.

| Lens | Score | One-line |
|------|-------|----------|
| Vertical sales OS (Hero / Jaipur / CRM) | 8.0 | Real product, not a demo |
| Conversational voice (latency, barge-in, TTS) | 5.0 | Works; feels like 2024 cascade |
| Compliance (TRAI / DPDP / WhatsApp) | 5.5 | Local DND + calling window; no NCPR/DLT/AI-disclosure |
| Security | 6.5 | API token OK; webhooks and WS are public |
| Operability (metrics, tests, migrations) | 5.5 | Unit tests on pure fns; no call-path e2e; push-only schema |
| Scale | 4.5 | One process, in-memory state |

---

## 1. Market research — what “best” means in 2026

Sources (August 2026): Awesome Agents platform test, Deepgram buyer’s guide, ContactWithAI five-platform bench, LiveKit cascade-vs-realtime, FutureAGI barge-in guide, ITU-T G.114, TRAI TCCCPR / DLT commentary, CarMax×Sierra, automotive-native vendors (Toma, Impel, Numa, Thoughtly).

### 1.1 Horizontal voice platforms (the stack Sakshi is compared to)

| Platform | Wins on | Typical E2E latency | Fit for Sakshi? |
|----------|---------|---------------------|-----------------|
| **ElevenLabs Agents** | Voice realism, 70+ languages, Flash TTS ~75 ms inference | ~700–900 ms published; Flash configs lower | Best **TTS upgrade** if Hindi Anushka is the complaint. Do not replace the whole agent. |
| **Vapi** | Swap STT/LLM/TTS; ~465–550 ms when tuned; 99.99% SLA claims | Sub-800 ms | Orchestration we already own. Buying Vapi would re-platform without adding Hero knowledge. |
| **Retell AI** | Balanced prod: ~600–780 ms, SOC2/HIPAA, monitoring | ~600 ms | Closest “call-center replacement.” Weak on India Hindi + two-wheeler catalog. |
| **Bland AI** | High-volume outbound, pathways, concurrency | ~700–900 ms | Similar job (outbound BDC). We already have dialer + retries. |
| **OpenAI Realtime / gpt-realtime** | Native barge-in, emotion, ~300–600 ms S2S | Sub-300 ms model; ~400–600 ms with telephony | Fast chitchat. **Bad default** here: we must log transcripts, inject EMI tables, and forbid money math. |
| **PolyAI / Sierra** | Enterprise inbound (CarMax uses Sierra for hours/availability/routing) | Not published; weeks-to-months implement | Different job: route + FAQ. Sakshi is a *salesperson*. |
| **Play.ai** | TTS component | Variable | Not an agent platform. |

**Industry threshold:** conversations that do not feel like IVR need **sub-800 ms** from end-of-user-speech to first agent audio. ITU-T G.114 still cites **< 300 ms** as “toll quality” for the *network* hop; agents add STT/LLM/TTS on top. Production barge-in: detect ~200 ms, TTS flush **< 60–150 ms**, false-barge **< 2%**, distinguish backchannels (“haan”, “achha”) from real interrupts.

Winning 2026 architecture is **not** “always S2S.” LiveKit and Inworld both say a **streaming cascade** (partial STT → LLM tokens → first TTS audio) can hit **400–600 ms** with full control. Naive cascade (wait for silence → full STT → full LLM → full TTS) lands at **2–3 s**. **Sakshi is still the naive cascade**, with two mitigations: LLM token stream split into sentences, and a 650 ms thinking filler.

### 1.2 Automotive-native agents (the product Sakshi is compared to)

Dealership buyers in 2026 do not ask “which TTS?” They ask: missed-call callback in seconds, test-drive on the calendar, **DMS/CRM writeback**, service + sales, after-hours coverage.

| Vendor | Job | vs Sakshi |
|--------|-----|-----------|
| **Toma / Numa / STELLA** | Fixed-ops + service scheduling, DMS | We have **no service-lane product** |
| **Impel / Matador / CallRevu / Fullpath** | Sales BDC, internet-lead speed-to-lead | We have speed-to-lead (`leadTrigger.ts`) but no BikeWale/BikeDekho native connector |
| **Thoughtly** | Voice + SMS + email sequence on one lead | We have voice + one-way WhatsApp; no SMS/email orchestration |
| **CarMax × Sierra** | Inbound routing, hours, availability, warm transfer; appointments next | We already transfer; we do not yet *book* a calendar slot into a dealer system |

Sakshi’s unique position: **two-wheeler India**, Hero catalog, Hindi BDC, rooftop CRM. US auto vendors will not beat that on Jaipur Hero. They *will* beat us on latency, live monitoring, and calendar/DMS writeback.

### 1.3 India compliance bar (non-optional for “production”)

TRAI TCCCPR 2018 + DLT (voice progressively in scope 2023–26) + DPDP:

- Calling window 9:00–21:00 IST for promotional (Sakshi stops at **20:00** and skips 13:00 — stricter, good).
- **NCPR/DND scrub before promotional outbound**, not only a CRM `doNotCall` flag set after the customer yells.
- Frequency caps commonly cited: **3 promo calls/day, 8/week**.
- PE + header registration; 140-series promo / 1600-series service numbers.
- Likely **AI disclosure** at start of commercial synthetic-voice calls (TRAI consultation; several 2026 vendor guides treat it as imminent). Sakshi’s prompt currently says **“Never mention being an AI.”**
- DPDP: consent, recording notice, retention, deletion. We have a one-line recording notice.
- WhatsApp: business-initiated messages need **DLT-registered / Meta-approved templates** outside the customer-care window. We send **freeform session text**.

---

## 2. Scorecard — Sakshi vs the 2026 bar

| Capability | Market production bar | Sakshi today | Gap |
|------------|----------------------|--------------|-----|
| Turn latency | 500–800 ms E2E; 400–600 ms streaming cascade | Target **3 000 ms**; batch STT (6 s timeout) + batch TTS (5 s) | **P0** |
| Streaming overlap | Partial STT → LLM → first TTS byte | Wait for 240 ms silence, then full utterance STT | **P0** |
| Barge-in | VAD + AEC; flush < 150 ms; truncate history to *heard* audio | RMS energy, 10 frames (~200 ms), Exotel `clear`, no history truncate | **P0** |
| Backchannel | “haan/achha” does not steal the floor | Any energy burst above 12× silence can abort TTS | **P1** |
| Voice quality | ElevenLabs / Flash-class; phone-tuned | Sarvam `bulbul:v2` Anushka, pace 0.85, 22.05 kHz → 8 kHz | **P1** |
| STT | Streaming ASR (Deepgram/Sarvam WS) + domain lexicon | Batch `saarika:v2.5` + Whisper fallback + `correctStt` | **P1** |
| Observability | Per-stage p50/p95, live listen-in, barge-in replay | pino logs; `StageTimer` **unwired**; no quality columns on `calls` | **P0** |
| Human handoff | Warm transfer + context to agent + no 404 | Transfer URL fixed; no whisper/context to the human | **P1** |
| Calendar / visit | Book test-ride on a real calendar | `visitScheduledAt` on lead; no Google/dealer calendar | **P1** |
| CRM writeback | Typed fields in UI + DMS | Scores computed, **UI + OpenAPI blind** | **P0** (value) |
| Outbound | Concurrency, AMD, NCPR, frequency cap | Dialer + retries + WhatsApp fallback; in-memory context; no NCPR | **P0** (compliance) |
| Auth | Signed webhooks, WS secret, RBAC | Single `ADMIN_TOKEN`; `/webhooks/*` public; **no `STREAM_SECRET` in code** | **P0** |
| Tests | Call simulation + latency CI gate | 8 unit files, ~420 lines, **no callStream/scheduler/webhook tests** | **P1** |
| Scale | Redis + multi-instance | In-memory circuit, cache, outbound map | **P2** (until 2nd instance) |
| Knowledge | Versioned, dated prices, eval set | Default catalog + admin append + review queue | **P1** |
| Multi-channel | Voice + WhatsApp session + SMS | Voice + one-way WhatsApp text | **P2** |

---

## 3. Macro audit

### 3.1 Architecture

Healthy pnpm monorepo. Right split: `lib/db` owns schema, `artifacts/api-server` owns the call, `artifacts/shubham-motors` owns the dealer UI. **No rewrite.**

Structural problems that *are* architecture:

1. **Naive cascade.** `runPipeline` concatenates PCM, resamples, `await speechToText(wav)`, then LLM, then `await textToSpeech` per sentence. Stages do not overlap. Filler masks LLM TTFT only.
2. **Two conversation runtimes.** Live path is WS (`callStream.ts`). Legacy **Record-and-Say** path in `webhooks.ts` still has its own in-memory `conversations` map and a second STT/LLM loop. Dual paths caused CRM bugs before; the Record path is still live.
3. **In-memory singleton state:** STT circuit, KB cache, greeting PCM cache, outbound context (5 min TTL), phrase cache. A second Node process silently splits the world.
4. **Contract lag.** Express has grown analytics/scheduler/campaigns/contacts. OpenAPI `Lead` schema still has ~12 fields; the table has 40+. Generated hooks cannot express Growth OS.
5. **Schema workflow.** `drizzle-kit push` only. A missing column already caused production dead-air (SELECT on `leads` throws before greeting; `/healthz` stays green).

### 3.2 Product

Sakshi is a **salesperson**, not a receptionist. That is the correct product bet vs Sierra-style routing bots.

Shipped and real: inbound/outbound Hindi, discovery memory, EMI table, transfer, follow-up state machine, speed-to-lead, visit reminder fields, relationship scores.

Invisible or incomplete for a GM:

- Revenue/relationship APIs exist; **dashboard does not chart them**.
- Lead detail uses `(lead as any)` for discovery; **no stage/persona/probability/₹**.
- Visit is a timestamp, not a booked slot with reminder SLA dashboard.
- No service-department agent (oil, insurance, job card) — fine for v1, say so explicitly.
- Prompt forbids AI identity; India is moving the other way.

### 3.3 Security

| Control | Status |
|---------|--------|
| `ADMIN_TOKEN` on `/api/*`, constant-time compare | OK |
| CORS allowlist via env | OK if `CORS_ORIGINS` set; **open CORS if unset** |
| Pino redacts auth headers | OK |
| Secrets from env, WhatsApp/Exotel read at call time | OK |
| `/webhooks/*` unsigned | **Fail** — spoofed status can complete follow-ups or fire WhatsApp |
| `/call/stream` WS | Audit claimed `STREAM_SECRET`; **it is not in source**. Missing `callSid` is not hard-rejected at start. |
| `/api/webhooks/exotel/dial-agent.xml?to=` | **Fail** — unauthenticated XML that dials any number you pass |
| Single shared admin token, no roles, stored in `localStorage` | Weak for a showroom floor |
| KB → LLM prompt | Admin-gated, but prompt-injection from a malicious KB row is possible |
| Rate limits | None |

### 3.4 Reliability & operations

June hardening is real: retries on WhatsApp/Exotel, 30 s OpenAI cap, STT circuit + Whisper, TTS Hindi retry, healthz DB ping.

Still not production-grade ops:

- No per-turn latency in logs from the live path (`StageTimer` unused).
- No error budget / SLO (e.g. “p50 turn < 1.2 s, p95 < 2.5 s”).
- No synthetic call in CI.
- CI uses **Node 22**; Replit/runtime is **Node 24**.
- No log/metrics backend (just stdout pino).
- Deploy depends on remember-to-`db push`. No migration journal.

### 3.5 Compliance & data

Good: IST callable window, `doNotCall` gate on dialer and instant-call, explicit opt-out regex, recording one-liner, `Record: true` on Exotel outbound.

Missing for India production:

- No NCPR/Exotel DND filter API before dial.
- No per-lead **consent source + timestamp** (DPDP + TRAI).
- No call-frequency cap (3/day, 8/week).
- No AI disclosure (and prompt actively forbids it).
- WhatsApp freeform, not templates.
- Transcripts/PII in Postgres with **no retention/TTL/delete-my-data**.
- Call audio not stored in *our* DB (harder DPDP fulfilment; also harder QA).
- Opt-out is regex in one file; WhatsApp “STOP” is not wired to `doNotCall`.

### 3.6 Cost & vendor lock

Cascade (Sarvam + gpt-4o + Exotel) is the right cost/control trade vs gpt-realtime for a sales agent that must not hallucinate EMIs. Keep it. Make it **stream**. Optional later: Realtime only for filler/chitchat turns; money turns stay cascade.

---

## 4. Micro audit

Findings are from current `main` / this branch. Severity: **P0** blocks “production grade,” **P1** customers feel or auditors flag, **P2** scale/maintain, **P3** polish.

### 4.1 Voice pipeline — `callStream.ts` (1 042 lines)

| ID | Sev | Finding |
|----|-----|---------|
| V-01 | P0 | **Batch STT.** `runPipeline` waits for 240 ms silence (`SILENCE_CHUNKS = 12`), then full WAV to Sarvam. No partials. Market overlap never starts. |
| V-02 | P0 | **Batch TTS.** `textToSpeech` returns a full clip (500-char cap). Sentence streaming is “TTS one sentence at a time,” not token-to-audio. First audio cannot beat STT+LLM+TTS sum. |
| V-03 | P0 | **Barge-in does not truncate history.** On interrupt, `ttsAbort` + Exotel `clear` stop *future* chunks. `session.history` still stores the full assistant text the customer never heard. Next turn the model thinks it finished the pitch. Market rule: truncate to played_ms. |
| V-04 | P1 | Barge-in is **RMS only** (`BARGE_IN_RMS = 0.096`, 10 frames, 400 ms grace). No Silero/WebRTC AEC. Phone echo and TV in background will false-trigger or miss soft interrupts. |
| V-05 | P1 | **No backchannel class.** “haan”, “achha”, “theek hai” can abort a price sentence. |
| V-06 | P1 | Language detect on turn 0 is **`void detectLanguage(...)`** (fire-and-forget). Memory said this was awaited. First reply can be Hindi TTS for an English utterance (or the reverse). |
| V-07 | P1 | `callStream` **reimplements lead lookup** (last-10 / `+91` / `91` loop) instead of `findOrCreateLead`. Duplicate phones and missed variants are possible. |
| V-08 | P1 | Claimed **`STREAM_SECRET` is absent**. WS accepts any client that can hit `/call/stream`. |
| V-09 | P1 | Greeting PCM cache is **process-local**. Personalized outbound greetings still hit live TTS every time (known gap). |
| V-10 | P2 | Proactive nudge + barge-in + filler is a state machine in one file with `ttsGen` / `isSpeaking` / `isProcessing`. Correct today; untested; easy to regress. |
| V-11 | P2 | Turn cap 25/30 then forced transfer — OK as safety, but no “wrap with WhatsApp and stop” for a customer who is done. |
| V-12 | P3 | Audio comments historically mixed μ-law vs PCM16; code path is PCM16LE @ 8 kHz. Confirm Exotel Voicebot codec in staging with a hex dump — mismatch is unintelligible audio. |

### 4.2 Speech vendors — `sarvam.ts`

| ID | Sev | Finding |
|----|-----|---------|
| S-01 | P0 | HTTP POST STT/TTS only. Sarvam has/had streaming APIs; unused. |
| S-02 | P1 | Circuit breaker is **module singleton**. Multi-instance: each process has its own idea of Sarvam health. |
| S-03 | P1 | Whisper fallback is **whisper-1** batch, 8 s timeout — can *add* latency on the worst turns. |
| S-04 | P2 | TTS `inputs: [speakable.slice(0, 500)]` silently truncates long list answers. |

### 4.3 LLM / knowledge — `openai.ts` (1 544 lines)

| ID | Sev | Finding |
|----|-----|---------|
| L-01 | P0 (policy) | Prompt: **“Never mention being an AI.”** Conflicts with TRAI synthetic-voice disclosure direction. Make disclosure a greeting prefix, not a prompt personality trait. |
| L-02 | P1 | Hybrid router streams tokens (good) then waits for sentence boundaries before TTS (necessary without streaming TTS). |
| L-03 | P1 | KB merge invariant is correct in comments; **no automated test** that `DEFAULT_HERO_KNOWLEDGE` is always present when admin rows exist. This already nuked production once. |
| L-04 | P1 | Prices live in prompt text. No `effective_date`, no eval set (“125cc list must include Xoom + Destini”). |
| L-05 | P2 | `gpt-4o` for every non-fast-path turn. Fast-path regex helps, but money/model turns still pay full LLM + 30 s timeout (timeout is a hang-break, not a latency budget). |

### 4.4 Post-call / CRM — `callFinalize.ts`, `relationshipIntel.ts`

| ID | Sev | Finding |
|----|-----|---------|
| C-01 | P0 | Intelligence is computed and stored; **OpenAPI `Lead` omits every June 2026 column** (segment, DND, scores, revenue…). UI cannot be typed. |
| C-02 | P1 | Finalize is well-guarded (analysis failure still sends WhatsApp). Good. |
| C-03 | P1 | `interestedModel` COALESCE is correct; still easy to break if a new writer bypasses finalize (legacy webhook path). |
| C-04 | P2 | Scores are deterministic but **uncalibrated** against actual conversions. No backtest. |

### 4.5 Dialer — `scheduler.ts`, `leadTrigger.ts`, `exotel.ts`

| ID | Sev | Finding |
|----|-----|---------|
| D-01 | P0 | No **NCPR** check. Internal `doNotCall` only. |
| D-02 | P0 | No **frequency cap** (TRAI 3/day class). A chatty lead can be dialed every retry window. |
| D-03 | P1 | Outbound context map TTL 5 min, **in-memory**. Slow Exotel connect → generic greeting. Second instance → always generic. |
| D-04 | P1 | `dial-agent.xml?to=` is an open click-to-call if an attacker knows the URL. |
| D-05 | P2 | `(followupsTable as any).attemptCount` — schema types exist; `as any` hides drift. |
| D-06 | P3 | Callable window ends 20:00 vs TRAI 21:00 — conservative, keep. |

### 4.6 WhatsApp — `whatsapp.ts`

| ID | Sev | Finding |
|----|-----|---------|
| W-01 | P0 | **Freeform `type: text`**. Meta Cloud API will reject business-initiated session messages outside the 24 h window. After a missed call, fallback WhatsApp is exactly that case. Need approved Hindi templates (summary, brochure, retry). |
| W-02 | P1 | No inbound WhatsApp webhook → `doNotCall` / “STOP”. |
| W-03 | P2 | Retries exist; no dead-letter / dealer-visible send failure. |

### 4.7 HTTP surface — `app.ts`, `auth.ts`, `webhooks.ts`, `analytics.ts`

| ID | Sev | Finding |
|----|-----|---------|
| H-01 | P0 | Unsigned Exotel webhooks. |
| H-02 | P0 | OpenAPI missing revenue/relationships/scheduler/campaigns/contacts and new lead fields. |
| H-03 | P1 | Legacy Record conversation loop still in `webhooks.ts` (~200 lines). |
| H-04 | P1 | Analytics SQL uses `as any` row maps; fine for now, not typed. |
| H-05 | P2 | Dashboard scheduler controls use raw `fetch`, bypassing generated client (and possibly auth header if `setAuthTokenGetter` is not applied to those calls). |

### 4.8 Data — `lib/db`

| ID | Sev | Finding |
|----|-----|---------|
| DB-01 | P1 | No FK `calls.lead_id` / `followups.lead_id`. |
| DB-02 | P1 | No versioned migrations. |
| DB-03 | P2 | No `calls.quality_json` / timings / barge-in counts. |
| DB-04 | P2 | No `consent_at` / `consent_source` / `ncpr_checked_at`. |
| DB-05 | P3 | `financerBanks` table exists; transfer uses `contacts` instead — possible dead schema. |

### 4.9 Frontend — `artifacts/shubham-motors`

| ID | Sev | Finding |
|----|-----|---------|
| UI-01 | P0 | Command center does not show pipeline ₹, personas, relationship bands. |
| UI-02 | P1 | Lead detail: discovery yes, Growth OS scores no; `as any`. |
| UI-03 | P1 | Token in `localStorage`; banner if missing — no login, no expiry, no SSO. |
| UI-04 | P2 | No live-call listen / barge-in replay (Retell’s differentiator). |

### 4.10 Tests & CI

| ID | Sev | Finding |
|----|-----|---------|
| T-01 | P1 | **Zero tests** for `callStream`, `scheduler`, `webhooks`, `callFinalize`, `auth`. The hottest, most-regressed files are untested. |
| T-02 | P1 | No golden-transcript eval (sporty → Xtreme list; 125cc includes scooters; EMI matches table). |
| T-03 | P2 | CI Node 22 vs app Node 24. |
| T-04 | P2 | Typecheck is the only frontend gate. |

---

## 5. What would make Sakshi *better than* market (not a clone)

Buying Retell would get latency and a pretty monitor. It would not get:

1. **Hero-Jaipur truth** — DEFAULT catalog + EMI table + “125 means CC.”
2. **Relationship CRM** — scores and lost-deal intel already computed.
3. **Sales craft** — stage machine, sporty mapping, visit reminder, speed-to-lead.
4. **India telephony** — Exotel + IST window + Hindi TTS pronunciation map.

So the strategy is: **keep the brain, upgrade the ears and mouth, close India compliance, show the GM the numbers.**

### 5.1 Voice stack (stay cascade, make it stream)

Do **not** switch the default to gpt-realtime. You would lose deterministic EMI, KB merge, and a text transcript for CRM.

Do:

1. **Streaming STT** (Sarvam streaming or a Hindi-strong streaming ASR) starting on speech onset, not after 240 ms silence.
2. **Streaming TTS** with first-byte < 200 ms; keep `ttsPrep` as the pronunciation gate.
3. **True barge-in:** VAD (or better energy + min-duration) + immediate `clear` + **truncate assistant history to played audio**.
4. **Backchannel ignore list** (haan, achha, hmm, theek hai) while speaking.
5. Wire `StageTimer`; SLO: **p50 turn gap < 800 ms, p95 < 1.5 s** on Jaipur PSTN. The 3 s target in the hardening doc is not a 2026 bar.
6. Optional: ElevenLabs multilingual for TTS A/B vs Anushka on 20 live calls — keep Sarvam if Hindi names/cc win.

### 5.2 Product (beat Toma/Impel on two-wheelers)

1. Surface Growth OS on dashboard + lead (already computed).
2. **Book** test rides (calendar or at least SMS ICS + day-of reminder SLA).
3. BikeWale / BikeDekho / Facebook lead webhooks → `triggerInstantLeadCall` in < 60 s.
4. Warm transfer: WhatsApp/SMS the human “caller wants Xtreme 160R, budget 1.2L, 15-day timeline” as the phone rings.
5. Service-lane later; don’t pretend to be Toma yet.

### 5.3 India production

1. Exotel DND/NCPR scrub on every promotional outbound; log `ncpr_checked_at`.
2. Consent ledger: source + time on lead.
3. Frequency cap in scheduler.
4. Greeting: recording notice **and** a short AI disclosure (“main digital assistant Sakshi…”) — env-flagged so legal can enable without a prompt rewrite.
5. WhatsApp **templates** for post-call, brochure, missed-call.
6. DPDP: retention (e.g. 90–180 days transcripts), export/delete endpoint.

### 5.4 Security / ops

1. Webhook HMAC or IP allowlist; **signed `to=` on dial-agent.xml**.
2. Implement the documented `STREAM_SECRET` (or Exotel custom param).
3. Rate-limit dial + webhooks.
4. Versioned migrations; FK constraints.
5. Redis before second replica.
6. Golden-call CI + one synthetic Exotel sandbox call in staging.

---

## 6. Gap register — ordered for “final production grade”

### Wave A — must fix before calling it production (P0)

| # | Gap | Why it is P0 |
|---|-----|----------------|
| A1 | Stream STT + first-byte TTS; drop 3 s SLO to **< 800 ms p50** | Market bar; customers hang up on IVR-feel |
| A2 | Barge-in truncates unheard assistant text | Wrong context = wrong next answer |
| A3 | Sign Exotel webhooks; lock `dial-agent.xml` | Anyone can fake call status or trigger outbound Dial |
| A4 | WhatsApp utility templates | Missed-call fallback will fail or violate Meta policy |
| A5 | NCPR/DND scrub + frequency cap | TRAI; `doNotCall` after the fact is too late |
| A6 | OpenAPI + CRM UI for scores/revenue | Growth OS is dark to the dealer |
| A7 | Wire `StageTimer` + persist timings on `calls` | Cannot prove A1 without it |

### Wave B — production-grade quality (P1)

| # | Gap |
|---|-----|
| B1 | VAD + backchannel; await language detect on turn 0 |
| B2 | `STREAM_SECRET`; reject empty `callSid` |
| B3 | AI disclosure flag; consent columns; recording retention |
| B4 | Use `findOrCreateLead` in `callStream` |
| B5 | Golden transcript tests + callFinalize/scheduler unit tests |
| B6 | Warm-transfer context to sales phone |
| B7 | Visit booking + reminder dashboard |
| B8 | TTS A/B (Anushka vs ElevenLabs Hindi) on real calls |
| B9 | Retire or strictly quarantine legacy Record webhook path |
| B10 | Instant-lead connectors (portal CSVs are not enough) |

### Wave C — scale and enterprise (P2)

Redis, migrations, FKs, OpenTelemetry, concurrent-call harness, RBAC, two-way WhatsApp, service-lane, multi-rooftop.

---

## 7. Explicit non-recommendations

- **Do not** migrate the agent to Vapi/Retell/Bland as the brain. You would spend a quarter re-learning EMI/KB/outbound invariants.
- **Do not** default to OpenAI Realtime for money turns.
- **Do not** rewrite `callStream.ts` “for cleanliness” without streaming STT/TTS in the same PR — a split without overlap is a 1 000-line shuffle.
- **Do not** add more intelligence columns until A6 (UI) and a conversion backtest exist.
- **Do not** enable a second replica before Redis + signed webhooks.

---

## 8. Suggested first engineering PR after this audit

Not a rewrite. One measurable slice:

**“Hear faster, prove it, stop the open Dial webhook.”**

1. Instrument `runPipeline` with `StageTimer` (even on the current batch path) and store `{sttMs, llmMs, ttsMs, totalMs, bargeIns}` on the call row.
2. Close `dial-agent.xml` (HMAC or server-side contact lookup, never raw `?to=`).
3. Add Exotel IP allowlist / shared secret on `/webhooks/*`.
4. Add 10 golden tests: opt-out regex, 125cc list, EMI table lookup, KB merge invariant, barge-in history truncate (once implemented).

That PR does not need a new vendor. It makes the next streaming-STT PR honest.

---

## 9. Method

- Market: public 2026 platform benches (Awesome Agents, ContactWithAI, Deepgram, LiveKit, FutureAGI, CallSphere), automotive (Thoughtly, Stork, CarMax/Sierra), India (Exotel TCCCPR FAQ, DLT/DND vendor guides). Treat vendor latency claims as **upper-bound marketing**; the architectural distinction (streaming overlap vs batch) is what we can verify in *this* repo.
- Macro/micro: current tree — `callStream.ts`, `sarvam.ts`, `openai.ts`, `callFinalize.ts`, `scheduler.ts`, `exotel.ts`, `whatsapp.ts`, `auth.ts`, `webhooks.ts`, `openapi.yaml`, CRM pages, schema, tests, CI, prior audits.

No production credentials were used. No live calls were placed.
