---
name: Sakshi outbound auto-dialer personalization wiring
description: How outbound-call personalization is plumbed across scheduler.ts, webhooks.ts, callStream.ts — and the two bugs that silently disable it.
---

# Outbound personalization wiring

Auto-dialer flow: `scheduler.ts` calls `setOutboundContext(phone, ctx)` right before `makeOutboundCall`, then `callStream.ts handleStart` reads it via `getOutboundContext(phone)` so Sakshi opens with "aapne pichli baar Splendor dekhi thi…" instead of a generic greeting.

Two things must hold or personalization silently no-ops (typecheck stays green, so it's easy to miss):

1. **`direction` must be passed in the ExoML `<Stream>`.** webhooks.ts must emit `<Parameter name="direction" value="outbound|inbound"/>`. callStream derives `isOutbound` from `customParameters.direction`; if absent it defaults to "inbound" and skips the outbound-context lookup entirely.

2. **The context map must be keyed identically on both sides.** Scheduler had raw `+91…`, callStream looked up last-10-digits → miss. Both `get/setOutboundContext` now normalize via `ctxKey()` = last-10 digits. Keep any new caller normalized too.

**Why:** These were shipped as "features" in an audit drop but were inert — no direction param + key mismatch meant every outbound call was treated as a cold inbound call.

# Auto-dialer retry / callable-window notes

- Scheduler cron is `*/30 * * * *`; `isCallableNow()` gates per-call in IST (server runs UTC). No calls before 9am, during 13:00 lunch hour, or after 20:00 IST.
- `attemptCount`/`lastAttemptAt` (followups table) are incremented on every attempt; at `attemptCount >= maxAttempts` the run sends a WhatsApp fallback instead of dialing.
- **Known gap (not yet built):** there is no Exotel answer-status webhook, so a *successfully initiated* call is marked `completed` immediately — true no-answer retries aren't possible yet. Retry only covers initiation failures. If you add a status callback, drive the no-answer→retry transition from it.
