# Shubham Motors AI Voice Agent
## Complete Audit Findings & Fix Report

**Project:** Shubham-Motors-AI (Sakshi Voice Agent)  
**Dealership:** Shubham Motors — Hero MotoCorp, Jaipur  
**Report date:** 8 June 2026  
**Prepared from:** Codebase review + test call recordings analysis  
**Patched codebase location:** `C:\Users\hp\Documents\Shubham-Motors-AI-review\Shubham-Motors-AI-main`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Test Call Analysis](#2-test-call-analysis)
3. [Critical Findings (Pre-Fix)](#3-critical-findings-pre-fix)
4. [Voice & Conversation Findings](#4-voice--conversation-findings)
5. [Database & Schema Findings](#5-database--schema-findings)
6. [Knowledge Base Findings](#6-knowledge-base-findings)
7. [Frontend & Operations Findings](#7-frontend--operations-findings)
8. [Production Readiness Gaps](#8-production-readiness-gaps)
9. [All Changes Implemented](#9-all-changes-implemented)
10. [New Files Created](#10-new-files-created)
11. [Files Modified](#11-files-modified)
12. [Deployment Checklist](#12-deployment-checklist)
13. [Remaining Recommendations](#13-remaining-recommendations)
14. [Appendix: Test Call Transcripts](#14-appendix-test-call-transcripts)

---

## 1. Executive Summary

The Shubham Motors AI voice agent ("Sakshi") is a functional end-to-end system: greeting, discovery, model listing, address handling, test-ride CTAs, CRM persistence, outbound dialer, and WhatsApp integration. However, it was **not production-ready** before this fix pass.

### Top risks identified (now fixed in code)

| # | Risk | Severity | Status |
|---|------|----------|--------|
| 1 | Call transfer URL pointed to wrong path (404 on handoff) | Critical | **Fixed** |
| 2 | Manual follow-up dial doubled Exotel webhook URL | Critical | **Fixed** |
| 3 | No API authentication on CRM / dialer / campaigns | Critical | **Fixed** |
| 4 | Split CRM persistence (WS vs webhook paths conflicted) | Critical | **Fixed** |
| 5 | Call data lost when no `callDbId` | Critical | **Fixed** |
| 6 | "Sporty" customer intent not understood | High | **Fixed** |
| 7 | TTS mispronunciation (Motors, Sakshi, kmpl, cc) | High | **Fixed** |
| 8 | Duplicate follow-ups on every completed call | High | **Fixed** |
| 9 | No phone uniqueness → duplicate leads | High | **Fixed** |
| 10 | Scheduler ignored stored outbound context | Medium | **Fixed** |

### Test recordings reviewed

| File | Duration | Number |
|------|----------|--------|
| `Call 01414937655_260608_122656.m4a` | ~70 sec | 01414937655 |
| `Call 01414937655_260608_125940.m4a` | ~80 sec | 01414937655 |

---

## 2. Test Call Analysis

### Call 1 — `Call 01414937655_260608_122656.m4a` (~70 seconds)

| Time | Event | Issue |
|------|-------|-------|
| 0–11s | Greeting with lead name "Rushab" | TTS said "शुभम वोटर" (Motors), "साखशी" (Sakshi); name heard as रुशप |
| 11–16s | Customer asks about bikes | OK |
| 16–28s | Thinking filler "एक सेकंड"; lists commuter vs sporty | OK intent |
| 28–31s | Customer: **"sporty mein?"** | Clear style preference |
| 31–42s | Agent lists 100cc / 125cc / 160cc categories | **Wrong** — should list Xtreme 125R, Xtreme 160R, Xpulse |
| 57–62s | Customer repeats **"sporty mein?"** | **No answer** — call ended / dead air |

**Root causes:**
- No `stylePreference` in discovery signals (only CC segment)
- `MAX_REPLY_SENTENCES = 2` could truncate list answers before CTA
- TTS `ttsPrep` not fully normalizing brand/name tokens on live Sarvam output

---

### Call 2 — `Call 01414937655_260608_125940.m4a` (~80 seconds)

| Time | Event | Issue |
|------|-------|-------|
| 0–10s | Personalized greeting | Same TTS issues |
| 10–15s | Customer wants address/location | OK |
| 15–23s | Jaipur showroom + WhatsApp location + test ride tonight | **Good sales behavior** |
| 26–32s | Customer asks which bikes; filler "देखती हूँ" | OK |
| 32–43s | Discovery: 100cc / 125cc / other | OK |
| 43–48s | Customer: "125cc mein" | OK |
| 49–76s | Lists Super Splendor XTEC, Glamour X, Xtreme 125R + CTA | **Missing Xoom 125 & Destini 125** (prompt requires all 125cc) |
| TTS | "kmpl" heard as "compel" | Missing kmpl rule in ttsPrep |

**Positives:** Address handling, WhatsApp offer, segment discovery, closing question — much closer to target behavior.

---

## 3. Critical Findings (Pre-Fix)

### 3.1 Call transfer URL wrong — transfers failed silently

**Location:** `artifacts/api-server/src/lib/exotel.ts` line 88

`transferCallToAgent()` pointed Exotel at:
```
/api/exotel/dial-agent.xml
```

Actual route registered at:
```
/api/webhooks/exotel/dial-agent.xml
```

**Impact:** Mid-call `[TRANSFER]` played "connecting…" then Exotel fetched 404. Customer never reached sales.

**Fix applied:** URL corrected to `/api/webhooks/exotel/dial-agent.xml`.

---

### 3.2 Manual follow-up execute doubled Exotel webhook URL

**Location:** `artifacts/api-server/src/routes/followups.ts` line 133

`makeOutboundCall()` already appends `/api/webhooks/exotel/inbound` to the base URL. Follow-up execute passed the full path as base, producing:
```
…/api/webhooks/exotel/inbound/api/webhooks/exotel/inbound
```

**Impact:** Follow-up calls from CRM "Execute" button never connected.

**Fix applied:** Pass `host` only via `getWebhookBaseUrl()`; mark follow-up as `dialing`; inject outbound context; create call record.

---

### 3.3 No authentication on production-critical endpoints

Only KB uploads, pending review, export/import, and contacts used `ADMIN_TOKEN`. Everything else was open:

| Endpoint | Risk |
|----------|------|
| `GET/POST/PATCH/DELETE /api/leads` | Full CRM read/write/delete |
| `POST /api/leads/:id/call` | Trigger outbound to any lead |
| `POST /api/scheduler/run` | Fire auto-dialer |
| `PATCH /api/scheduler/config` | Change cron, call volume |
| `POST /api/campaigns/:id/send` | WhatsApp blast |
| `POST /api/calls/:id/transfer` | Transfer live calls |
| `POST /api/knowledge` (create) | Inject KB without admin token |
| WebSocket `/call/stream` | Open connection, no signature check |

**Fix applied:** Global `requireApiAuth` middleware on all `/api/*` except `/healthz` and `/webhooks/*`. Frontend sends token via `setAuthTokenGetter`. Optional `STREAM_SECRET` for WS.

---

### 3.4 Call data lost when no lead / no `callDbId`

**Location:** `artifacts/api-server/src/lib/callStream.ts` `handleStop()`

```typescript
if (!transcript || !session.callDbId) return;
```

If lead lookup failed → no call row → transcript, summary, CRM updates, follow-ups all dropped.

**Fix applied:** Create call row on stop if missing; use unified `finalizeCompletedCall()`.

---

### 3.5 Duplicate / conflicting CRM persistence paths

| Path | Used for | Problem |
|------|----------|---------|
| WebSocket `callStream.ts` `handleStop()` | Live voice calls | Overwrote `interestedModel`; no `whatsappSent`; no `nextFollowupAt`; no brochure |
| HTTP `webhooks.ts` `/status` | Legacy Record flow | Empty in-memory `conversations` for WS calls; used `COALESCE` for model |

**Fix applied:** Single `callFinalize.ts` module used by WS path with COALESCE model, deduped follow-ups, WhatsApp, brochure, `nextFollowupAt`.

---

### 3.6 Every completed call inserted new follow-up (no dedup)

`handleStop()` always inserted when `computeFollowupDate()` returned non-null. Warm leads accumulated overlapping scheduled callbacks.

**Fix applied:** Check for existing `pending` follow-up before insert.

---

### 3.7 `mapExotelStatus` defaulted unknown statuses to `"completed"`

**Location:** `artifacts/api-server/src/routes/webhooks.ts`

Unknown/failed Exotel statuses treated as answered → outbound follow-up marked completed instead of retried.

**Fix applied:** Default changed to `"failed"`.

---

## 4. Voice & Conversation Findings

| # | Issue | Evidence | Fix |
|---|-------|----------|-----|
| V1 | Brand/name TTS | "Shubham Motors" → "वोटर", "Sakshi" → "साखशी" | Expanded `ttsPrep.ts` (Motors, Sakshi, Shubham, help) |
| V2 | CC pronunciation | "100cc" → "चीची" on call | Hindi cc rules in ttsPrep; LLM uses सीसी |
| V3 | kmpl / English units | "65 kmpl" → "65 compel" | Added kmpl → किलोमीटर प्रति लीटर |
| V4 | "Sporty" not understood | Call 1: asked twice, got CC list | Added `stylePreference` to discovery signals |
| V5 | Incomplete 125cc list | Call 2: 3 bikes, no scooters | `MAX_REPLY_SENTENCES` raised to 3; prompt enforced |
| V6 | Thinking fillers audible | "एक सेकंड", "देखती हूँ" | Conditional filler (650ms delay) already present |
| V7 | Proactive nudges in Roman Hindi | `getProactiveMessage()` Latin script | Rewritten in Devanagari |
| V8 | No TTS fallback | STT had Whisper fallback; TTS did not | Simplified Hindi retry in `sarvam.ts` |
| V9 | Language race turn 1 | `detectLanguage()` async on turn 0 | Now awaited before first reply |
| V10 | `not_interested` fast-path | Spoke goodbye only | Sets lead `not_interested`, cancels follow-ups |
| V11 | Call ends without answer | Call 1 dead air ~57s | Proactive nudge on TTS failure |
| V12 | Audio format comment mismatch | Header said μ-law; code uses PCM16LE | Comment corrected |
| V13 | Personalized greeting not cached | Outbound greetings always hit live TTS | Documented; name prep via `prepareNameForTts` |

---

## 5. Database & Schema Findings

| Issue | Impact | Fix |
|-------|--------|-----|
| No versioned SQL migrations | No rollback; prod drift | Schema indexes added; still use `drizzle-kit push` |
| No FK on `calls.lead_id`, `followups.lead_id` | Orphan rows | Documented; indexes added |
| No unique index on `leads.phone` | Duplicate leads | **Unique index added** |
| No index on `calls.exotel_call_sid` | Slow webhook lookups | **Index added** |
| No index on `followups(status, scheduled_at)` | Scheduler scan growth | **Index added** |
| `calls.direction` default `"outbound"` | Misleading for inbound | **Default → `inbound`** |
| `campaignRecipients` no unique `(campaign_id, lead_id)` | `onConflictDoNothing()` broken | **Unique constraint added** |
| Lead delete without cascade | Orphan calls/followups | Documented |
| `segment` column missing in prod | Silent dead call on start | Documented: must run `db push` after schema change |
| `followups.outboundContext` ignored by scheduler | Lost rich context on retry | **Scheduler now reads stored JSONB** |

---

## 6. Knowledge Base Findings

| Issue | Detail |
|-------|--------|
| Embedded catalog solid | `DEFAULT_HERO_KNOWLEDGE` has prices, EMI table, stock, offers |
| Showroom address inconsistency | Fast-path said "Lal Kothi, Tonk Road"; KB said only "Jaipur" → **Aligned** |
| Legacy prompt in `attached_assets/` | Old 30/70 rule; runtime prompt in `openai.ts` is current |
| KB CRUD unauthenticated | Anyone could change live agent knowledge → **Now behind API auth** |
| Offer image upload no cache invalidation | 5 min stale window → **Fixed: `invalidateKnowledgeCache()`** |
| Prices dated 16-May-2026 | Need admin update workflow + disclaimer on calls |

---

## 7. Frontend & Operations Findings

| Issue | Fix |
|-------|-----|
| No login; admin token only for uploads | `setAuthTokenGetter` on all API calls; banner when missing |
| `Leads.tsx` filter `"followup"` invalid | Replaced with `not_interested`, `wrong_number` |
| CSV import naive comma-split | Quoted-field CSV parser added |
| Followups "Execute" broken URL | Fixed in `followups.ts` |
| Scheduler `callbackBaseUrl` → localhost | `getWebhookBaseUrl()` shared helper |
| In-memory state (context, cache) | Documented: breaks multi-instance |
| No automated tests | Documented |
| Health check minimal | **DB + env + scheduler in `/healthz`** |
| Leads filter OR instead of AND | **Fixed: `and(...conditions)`** |
| Calls list oldest first | **Fixed: `desc(createdAt)`** |
| Manual outbound no personalization | **`setOutboundContext()` on manual dial** |
| Lead import no dedup | **Upsert on phone conflict** |

---

## 8. Production Readiness Gaps

| Area | Pre-fix | Post-fix |
|------|---------|----------|
| Auth & RBAC | ❌ Open | ✅ `ADMIN_TOKEN` on all API |
| Exotel webhooks | ❌ No verification | ⚠️ Still open (IP allowlist recommended) |
| Call transfer | ❌ Broken URL | ✅ Fixed |
| Follow-up dial | ❌ Doubled URL | ✅ Fixed |
| CRM consistency | ⚠️ Split paths | ✅ Unified `callFinalize.ts` |
| Phone normalization | ⚠️ Duplicates | ✅ `normalizePhone` + unique index |
| DB migrations | ❌ Push only | ⚠️ Indexes added; still push-based |
| Multi-instance | ❌ In-memory state | ⚠️ Redis recommended |
| Observability | ⚠️ Pino only | ✅ Enhanced health check |
| TTS quality | ⚠️ Poor on calls | ✅ ttsPrep + fallback |
| Conversation AI | ⚠️ Sporty gap | ✅ stylePreference |
| Rate limiting | ❌ None | ⚠️ Recommended |
| Compliance (DNC) | ❌ Not persisted | ✅ `not_interested` updates lead |
| Testing | ❌ None | ⚠️ Recommended |

---

## 9. All Changes Implemented

### 9.1 Critical infrastructure

1. **Transfer URL fixed** — `exotel.ts`: `/api/webhooks/exotel/dial-agent.xml`
2. **Follow-up execute fixed** — `followups.ts`: host-only URL, `dialing` status, outbound context, call record
3. **API authentication** — `middlewares/auth.ts` + `app.ts` global guard
4. **Unified post-call CRM** — `lib/callFinalize.ts` (COALESCE model, dedup follow-ups, WhatsApp, brochure, `nextFollowupAt`, cancel on `not_interested`)
5. **Call data recovery** — `handleStop` creates call row if missing
6. **Exotel status mapping** — unknown → `failed`
7. **Campaign dedup** — unique index + `onConflictDoNothing` target

### 9.2 CRM & data

8. **Phone normalization** — `lib/phone.ts`, `lib/leadLookup.ts`
9. **Leads filter AND logic** — `leads.ts`
10. **Import upsert on phone** — `leads.ts`
11. **Manual outbound context** — `leads.ts` + `setOutboundContext`
12. **Webhooks lead lookup** — `findOrCreateLead`, no `leadId: 0` orphan calls
13. **Calls list newest first** — `desc(createdAt)`

### 9.3 Voice pipeline

14. **TTS pronunciation** — Motors, Sakshi, Shubham, kmpl, help in `ttsPrep.ts`
15. **TTS fallback** — simplified Hindi retry in `sarvam.ts`
16. **`stylePreference` discovery** — sporty / family / commuter in `openai.ts`
17. **Sporty → segment mapping** — defaults to 160cc+ when sporty without CC
18. **Proactive nudges Devanagari** — `getProactiveMessage()` in `callStream.ts`
19. **Language detection awaited** — turn 0 in `runPipeline`
20. **`not_interested` CRM update** — fast-path + `callFinalize`
21. **MAX_REPLY_SENTENCES = 3** — room for list + CTA
22. **TTS failure recovery** — proactive nudge after 3s
23. **WS security** — reject missing `callSid`; optional `STREAM_SECRET`
24. **Showroom address aligned** — Lal Kothi, Tonk Road in KB + fast-path
25. **`prepareNameForTts`** — customer name handling

### 9.4 Scheduler & ops

26. **Scheduler reads `outboundContext` JSONB** from follow-up row
27. **`getWebhookBaseUrl()`** — no localhost in production config
28. **Callable window fix** — evening bypass only after 2+ attempts
29. **Health check enhanced** — DB ping, env flags, scheduler status
30. **Startup warnings** — missing `ADMIN_TOKEN`, `SARVAM_API_KEY`, `DATABASE_URL`
31. **Offer upload cache invalidation** — `knowledge.ts`
32. **CORS configurable** — `CORS_ORIGINS` env var

### 9.5 Frontend

33. **`setAuthTokenGetter`** — `main.tsx`
34. **Admin token banner** — `Layout.tsx`
35. **Lead status filters fixed** — `Leads.tsx`
36. **CSV quoted-field parser** — `Leads.tsx`

---

## 10. New Files Created

| File | Purpose |
|------|---------|
| `artifacts/api-server/src/lib/phone.ts` | `normalizePhone()`, `phoneLookupVariants()` |
| `artifacts/api-server/src/lib/publicUrl.ts` | `getPublicBaseUrl()`, `getWebhookBaseUrl()` |
| `artifacts/api-server/src/middlewares/auth.ts` | `requireApiAuth`, `requireAdmin`, `isPublicApiPath` |
| `artifacts/api-server/src/lib/leadLookup.ts` | `findLeadByPhone()`, `findOrCreateLead()` |
| `artifacts/api-server/src/lib/callFinalize.ts` | Unified post-call CRM persistence |

---

## 11. Files Modified

| File | Changes |
|------|---------|
| `lib/db/src/schema/leads.ts` | Unique index on `phone` |
| `lib/db/src/schema/calls.ts` | Default direction `inbound`; indexes on `exotel_call_sid`, `lead_id` |
| `lib/db/src/schema/followups.ts` | Indexes on `(status, scheduled_at)`, `lead_id` |
| `lib/db/src/schema/campaignRecipients.ts` | Unique `(campaign_id, lead_id)` |
| `artifacts/api-server/src/lib/exotel.ts` | Transfer URL fix; use `getPublicBaseUrl` |
| `artifacts/api-server/src/app.ts` | Auth middleware; configurable CORS |
| `artifacts/api-server/src/index.ts` | Startup env warnings |
| `artifacts/api-server/src/routes/followups.ts` | Execute URL fix; outbound context; `dialing` state |
| `artifacts/api-server/src/routes/leads.ts` | Phone normalize; AND filter; import upsert; outbound context |
| `artifacts/api-server/src/routes/calls.ts` | Newest-first ordering |
| `artifacts/api-server/src/routes/webhooks.ts` | `findOrCreateLead`; status default; no orphan calls |
| `artifacts/api-server/src/routes/campaigns.ts` | `onConflictDoNothing` with target |
| `artifacts/api-server/src/routes/knowledge.ts` | Offer upload cache invalidation |
| `artifacts/api-server/src/routes/health.ts` | DB + env + scheduler checks |
| `artifacts/api-server/src/lib/callStream.ts` | Major: finalize, discovery, sporty, Devanagari nudges, auth, TTS recovery |
| `artifacts/api-server/src/lib/scheduler.ts` | Export `setOutboundContext`; read stored context; callable window; webhook URL |
| `artifacts/api-server/src/lib/openai.ts` | `stylePreference`; showroom address; discovery signals |
| `artifacts/api-server/src/lib/ttsPrep.ts` | Brand/name/kmpl rules; `prepareNameForTts` |
| `artifacts/api-server/src/lib/sarvam.ts` | TTS simplified Hindi fallback |
| `artifacts/api-server/src/lib/voiceFastPath.ts` | `detectIntentWithMeta`; address in Devanagari |
| `artifacts/shubham-motors/src/main.tsx` | `setAuthTokenGetter` |
| `artifacts/shubham-motors/src/components/Layout.tsx` | Admin token warning banner |
| `artifacts/shubham-motors/src/pages/Leads.tsx` | Status filters; CSV parser |

---

## 12. Deployment Checklist

### Environment variables (required)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection |
| `ADMIN_TOKEN` | API authentication (same value in CRM Settings) |
| `SARVAM_API_KEY` | STT + TTS |
| `EXOTEL_SID` | Telephony |
| `EXOTEL_API_KEY` | Telephony |
| `EXOTEL_API_TOKEN` | Telephony |
| `EXOTEL_VIRTUAL_NUMBER` | Outbound caller ID |
| `PORT` | Server port (e.g. 5000) |

### Environment variables (recommended)

| Variable | Purpose |
|----------|---------|
| `PUBLIC_BASE_URL` or `REPLIT_DOMAINS` | Webhook + transfer URLs |
| `OPENAI_API_KEY` | LLM + Whisper STT fallback |
| `STREAM_SECRET` | WebSocket hardening (pass in Exotel custom params) |
| `CORS_ORIGINS` | Comma-separated allowed origins |
| `SALES_TRANSFER_NUMBER` | Fallback transfer target |

### Steps

1. Deploy patched code from `Shubham-Motors-AI-review\Shubham-Motors-AI-main`
2. Set all required env vars
3. Run database schema push:
   ```bash
   pnpm --filter @workspace/db run push
   ```
4. Set **Admin Token** in CRM → Settings (must match `ADMIN_TOKEN`)
5. Re-publish / restart the server
6. Retest:
   - [ ] Inbound call — greeting plays
   - [ ] Say "sporty mein?" — lists Xtreme / Xpulse models
   - [ ] Say "125cc mein" — lists bikes + scooters
   - [ ] Follow-up Execute — call connects
   - [ ] Transfer to sales — customer bridged (not 404)
   - [ ] CRM requires token (401 without it)
   - [ ] Call completes — WhatsApp summary + follow-up scheduled (no duplicate)

---

## 13. Remaining Recommendations

These were **not implemented** (require infrastructure or larger refactors):

| Item | Why |
|------|-----|
| Redis for outbound context / phrase cache / KB cache | Multi-instance deployment |
| Exotel webhook IP allowlist / signature verification | Security hardening |
| Versioned SQL migrations (not just `drizzle-kit push`) | Rollback + audit trail |
| Automated E2E call simulation tests | Quality gate |
| Rate limiting on webhooks and outbound dial | Abuse prevention |
| APM / per-turn latency metrics | Observability |
| FK constraints on `calls.lead_id`, `followups.lead_id` | Referential integrity |
| Cascade delete leads → calls/followups | Data hygiene |
| Remove legacy Record webhook path in `webhooks.ts` | Architecture simplification |
| Personalized greeting PCM cache for outbound | Latency optimization |

---

## 14. Appendix: Test Call Transcripts

*Transcribed via local Whisper (Hindi). Timestamps approximate.*

### Call 1 — 122656

```
[  1.5- 11.2] नमस्ते रुशप जी, मैं साखशी बोल रही हूँ, शुभम वोटर से...
[ 11.2- 16.2] (customer asks about bike)
[ 16.2- 27.8] अच्का जी एक सेकन... HF Deluxe, Splendor, Passion... sporty...
[ 27.8- 30.8] अग, स्पोटी मैं?
[ 30.8- 41.6] ...100cc, 125cc, 160cc की बाइक...
[ 57.1- 62.1] अग, स्पोटी मैं?
(end — no answer)
```

### Call 2 — 125940

```
[  3.3- 10.3] नमस्ते रुशब जी, मैं साखशी बोल रही हूँ, शुभम वोटर से...
[ 10.3- 14.3] (customer wants address)
[ 14.3- 22.9] शोरूम जयपुर में... वॉट्सऐप पर लोकेशन... टेस्ट राइड?
[ 26.9- 28.9] यहाँ पे बाइक तो बताओ कौन कौन सी?
[ 32.4- 43.4] 100cc, 125cc, या कुछ और?
[ 43.4- 45.4] 125cc में?
[ 49.8- 75.8] Super Splendor XTEC, Glamour X, Xtreme 125R... family vs sporty? daily km?
```

---

## Document Info

- **Source zip reviewed:** `Shubham-Motors-AI-main (4).zip`
- **Recordings reviewed:** `Call 01414937655_260608_122656.m4a`, `Call 01414937655_260608_125940.m4a`
- **Fix pass completed:** 8 June 2026
- **Report file:** `C:\Users\hp\Documents\Shubham-Motors-AI-Audit-and-Fixes-Report.md`

---

*End of report*
