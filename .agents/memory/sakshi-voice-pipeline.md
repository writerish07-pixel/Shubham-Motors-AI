---
name: Sakshi voice pipeline — fillers, topic interrupt, and uploaded forks
description: Design rules for thinking-fillers and topic-interrupt in the Exotel WS turn loop, plus how to handle user-uploaded "_v3" code drops.
---

## Uploaded refactor drops: ALWAYS diff first — could be an older fork OR a clean superset
**Rule:** Never copy a user-uploaded file wholesale on faith. Diff it both ways first. Some drops are forked from an OLDER revision (would regress current code); others are a proper SUPERSET of current (safe to replace verbatim). Decide per-diff.
**Why:** One "_v3" drop would have dropped DEFAULT_HERO_KNOWLEDGE always-merge, `tryDirectAnswer`, and the rich sales prompt (its prompt ended in bare `${knowledge}`) → had to cherry-pick. A later drop was a true superset (contained all current work + proactive engine + segment recommender) → safe to overwrite.
**How to apply:** Run `diff upload current` and inspect the `^>` (current-only) lines — those are what an overwrite would LOSE. If `^>` is empty / only intentional replacements, overwrite is safe. If `^>` contains live current logic (KB merge, EMI table, fillers), it's an older fork → cherry-pick instead. Always re-verify the invariants survive: DEFAULT_HERO_KNOWLEDGE merged, `tryDirectAnswer`, EMI ZERO-ARITHMETIC rule + precomputed table.

## Thinking fillers must NOT fire-and-forget (audio overlap race)
**Rule:** The thinking-filler (short cached phrase that masks LLM first-token latency) must be chained, not parallel. Init the sentence `playChain` to the filler promise (`let playChain = fillerDone`) so the first real LLM sentence plays AFTER the filler — never overlapping it on the same streamSid.
**Why:** The naive uploaded version fired the filler as a detached IIFE that set isSpeaking and called playPcm8k in parallel with the LLM TTS path → two PCM streams interleave on one WS = garbled audio.
**How to apply:** Filler runs as `const fillerDone = (async()=>{...})().catch(()=>{})`, guarded by `session.ttsGen===myGen && !ttsAbort && !isClosed && ws.OPEN`. Don't touch `isSpeaking` inside it — the outer turn owns isSpeaking. `playPcm8k` already breaks mid-stream on `session.ttsAbort`, so barge-in cancels the filler too. Fillers live in `voiceFastPath.THINKING_FILLERS` and are added to CACHED_PHRASES so they're warmed (instant) at boot. Fast-path turns early-return before the filler, so it only fires on real LLM turns.
**Conditional (latency-gated):** the filler is NOT spoken on every turn. It waits `FILLER_DELAY_MS` (~650ms); the first sentence's play closure sets `firstSentenceReady=true` right after its TTS resolves, and the filler skips if that flag is set when its timer fires. So fast/direct-KB answers (ready <650ms) get no filler; only genuinely slow LLM turns do. Re-check the flag after the (possibly awaited) filler TTS too.

## Proactive nudge engine: cancel the timer on speech ONSET, not end-of-utterance
**Rule:** The proactive sales engine (scheduleProactiveNudge fires getProactiveMessage when the customer goes silent) MUST cancel its timer the instant inbound speech is detected in handleMedia (when `energy > SILENCE_RMS` and `speechCount===0`), AND the timer callback must bail if `session.speechCount > 0`.
**Why:** Cancelling only at runPipeline start (which runs after end-of-utterance detection) leaves a window where the customer is mid-sentence — isProcessing & isSpeaking are both still false — so the nudge fires and talks over the caller. That is the exact failure the feature is meant to prevent, and it also corrupts STT.
**How to apply:** Two guards, both required: (1) `if (session.speechCount === 0) cancelProactiveTimer(session)` inside the speech-onset branch of handleMedia; (2) `if (session.speechCount > 0) return;` in the setTimeout callback. Nudge audio is otherwise barge-in-safe (shared isSpeaking/ttsAbort/ttsGen + playPcm8k mid-stream abort). Timer is cleared on teardown via handleStop (covers both `stop` and WS `close`).

## Topic-interrupt detection: high-signal buckets only
**Rule:** `detectTopicShift(lastAgentText, customerText)` must use specific terms per bucket. Exclude bare generic Hindi tokens (kitna / kab / kahan / monthly / cost / rupee) — they match almost any question and fire spurious interrupts every turn.
**Why:** A spurious interrupt injects a "TOPIC INTERRUPT — HIGHEST PRIORITY, answer this new question FIRST" block into the prompt, derailing Sakshi's flow.
**How to apply:** On a real shift, set `session.pendingQuestion`, pass it as the optional trailing arg to `generateAgentReplyStream`, thread through `buildSystemPrompt` into the existing rich prompt; clear `pendingQuestion` each turn. Keep `pendingQuestion` an OPTIONAL param so other call sites (webhooks) stay backward compatible.
