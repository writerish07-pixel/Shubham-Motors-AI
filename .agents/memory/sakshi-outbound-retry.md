---
name: Sakshi outbound follow-up retry state machine
description: How outbound auto-dialer follow-ups transition through statuses and how the Exotel status webhook drives retries. Read before touching scheduler.ts or the /webhooks/exotel/status route.
---

# Outbound follow-up retry state machine

The scheduler (auto-dialer) and the Exotel call-status webhook together form one
state machine over `followups.status`. Keep them consistent or retries break.

## Status lifecycle (outbound follow-ups)
`pending` → (scheduler dials) → `dialing` → (status webhook resolves) →
- answered            → `completed`
- not answered, attempts remain → `pending` (rescheduled now + retryDelayMinutes)
- not answered, attempts exhausted → `whatsapp_fallback` (sends WhatsApp once)

## Single-owner rule
**All outbound retry policy lives in `resolveOutboundFollowupOutcome(callId, answered)`
in scheduler.ts.** The webhook (`/webhooks/exotel/status`) only calls it; it does not
decide retries itself. Don't duplicate retry logic in the webhook.

## Why a follow-up is `dialing`, not closed on dial
The scheduler used to mark a follow-up `completed` the instant it placed a call, so
no-answer retries were impossible and "reached them" reporting was wrong. Now the
scheduler sets `dialing` + links `followup.callId = newCall.id` so the status webhook
can find and resolve the right row (`WHERE callId = ? AND status = 'dialing'`).

## Attempt counting — single increment per dial
`attemptCount` is incremented **only** by the scheduler's pre-dial atomic claim
(once per dial). The resolver NEVER increments. The dial-failure branch must NOT
increment again (the claim already did) — it just resets `dialing` → `pending`.

## Concurrency guards (do NOT remove)
- **Scheduler pre-dial claim**: a guarded `UPDATE ... WHERE id=? AND status=<status we
  selected>` runs *before* `makeOutboundCall`. Since the webhook only ever moves a row
  OFF `dialing`, a matching status proves no webhook resolved it; rowCount 0 ⇒ skip.
  This prevents placing a duplicate call for a row that was just resolved.
- **Resolver claim**: decides next state, then a single guarded `UPDATE ... WHERE id=?
  AND status='dialing'` with `.returning()`. Side effects (WhatsApp fallback send) fire
  ONLY after winning the claim, so duplicate Exotel webhook deliveries can't double-send.
- **Why:** Exotel can deliver the same terminal webhook more than once, and the
  scheduler may concurrently re-dial a stale `dialing` row.

## Stale-dialing recovery
The due-query also picks up `dialing` rows whose `lastAttemptAt <= now - STALE_DIALING_MS`
(15 min) so a follow-up isn't stuck forever if the status webhook never arrives. Such a
row goes through the normal claim/dial/retry path again.

## Status mapping (mapExotelStatus in webhooks.ts)
completed→completed, no-answer/busy→missed, failed→failed, in-progress→in_progress,
ringing→ringing. Terminal set acted on by the resolver call = completed/missed/failed;
`answered = (dbStatus === "completed")`.
