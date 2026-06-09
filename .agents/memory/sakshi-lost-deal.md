---
name: Sakshi lost-deal terminal handling
description: lostDeal must gate follow-up cancel/skip like terminal intents, not only set lead status.
---

# Lost-deal is terminal for follow-ups, not just for status

The "lost-deal intelligence" feature (analyzeCallIntent returns `lostDeal` +
`lostToBrand/Dealer/Reason/OfferFactor`) sets lead status to `"lost"` in
callFinalize. But status alone is NOT enough.

## Rule
In `finalizeCompletedCall` (callFinalize.ts), follow-up handling must treat
`lostDeal` as terminal alongside `terminalIntent` (not_interested / wrong_number):
cancel any pending follow-ups AND never schedule a new one. Use a combined
`terminalForFollowup = terminalIntent || Boolean(analysis.lostDeal)` gate.

**Why:** when the fork's lost-deal feature was merged, the new-status branch set
`"lost"` but the follow-up cancel/schedule block was still gated only by
`terminalIntent`. Result: a lost lead kept pending follow-ups and could even get a
new one scheduled (wasted automation calls to a customer who already bought
elsewhere).

**How to apply:** any new "dead lead" outcome (bought elsewhere, do-not-call,
etc.) must extend the follow-up terminal gate, not just the status ternary. Status
and follow-up scheduling are two separate decisions in callFinalize — keep them in
sync.
