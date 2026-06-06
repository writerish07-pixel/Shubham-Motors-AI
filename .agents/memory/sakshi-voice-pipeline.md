---
name: Sakshi voice pipeline — fillers, topic interrupt, and uploaded forks
description: Design rules for thinking-fillers and topic-interrupt in the Exotel WS turn loop, plus how to handle user-uploaded "_v3" code drops.
---

## Uploaded "_v3" / refactor drops are often branched off an OLDER base
**Rule:** Never copy a user-uploaded refactor file wholesale into the Sakshi files. Diff it first; the upload is frequently forked from an older revision and would regress the current superior code.
**Why:** A "_v3" drop once would have dropped the DEFAULT_HERO_KNOWLEDGE always-merge, the `tryDirectAnswer` direct-KB tier, and the rich sales prompt (EMI table, zero-arithmetic rule, KM/day tiers, LAER) — its prompt ended in a bare `${knowledge}`.
**How to apply:** Cherry-pick only the genuinely-new features; keep the current prompt/KB/EMI machinery intact. Confirm via diff direction before any merge.

## Thinking fillers must NOT fire-and-forget (audio overlap race)
**Rule:** The thinking-filler (short cached phrase that masks LLM first-token latency) must be chained, not parallel. Init the sentence `playChain` to the filler promise (`let playChain = fillerDone`) so the first real LLM sentence plays AFTER the filler — never overlapping it on the same streamSid.
**Why:** The naive uploaded version fired the filler as a detached IIFE that set isSpeaking and called playPcm8k in parallel with the LLM TTS path → two PCM streams interleave on one WS = garbled audio.
**How to apply:** Filler runs as `const fillerDone = (async()=>{...})().catch(()=>{})`, guarded by `session.ttsGen===myGen && !ttsAbort && !isClosed && ws.OPEN`. Don't touch `isSpeaking` inside it — the outer turn owns isSpeaking. `playPcm8k` already breaks mid-stream on `session.ttsAbort`, so barge-in cancels the filler too. Fillers live in `voiceFastPath.THINKING_FILLERS` and are added to CACHED_PHRASES so they're warmed (instant) at boot. Fast-path turns early-return before the filler, so it only fires on real LLM turns.

## Topic-interrupt detection: high-signal buckets only
**Rule:** `detectTopicShift(lastAgentText, customerText)` must use specific terms per bucket. Exclude bare generic Hindi tokens (kitna / kab / kahan / monthly / cost / rupee) — they match almost any question and fire spurious interrupts every turn.
**Why:** A spurious interrupt injects a "TOPIC INTERRUPT — HIGHEST PRIORITY, answer this new question FIRST" block into the prompt, derailing Sakshi's flow.
**How to apply:** On a real shift, set `session.pendingQuestion`, pass it as the optional trailing arg to `generateAgentReplyStream`, thread through `buildSystemPrompt` into the existing rich prompt; clear `pendingQuestion` each turn. Keep `pendingQuestion` an OPTIONAL param so other call sites (webhooks) stay backward compatible.
