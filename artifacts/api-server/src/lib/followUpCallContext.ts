/**
 * Follow-up call behaviour — ported from reference agent.py build_system_prompt()
 * and get_opening_message(). Continues prior conversation; asks purchase outcome first.
 */

import type { LeadProfile } from "./openai";

export function isFollowUpCall(priorCompletedCalls: number, isOutbound: boolean): boolean {
  return priorCompletedCalls >= 1 || isOutbound;
}

/** Opening line for outbound / return calls — verify purchase before re-pitching. */
export function buildPurchaseVerificationGreeting(
  leadName: string,
  interestedModel?: string | null,
  followupReason?: string | null,
): string {
  const name = leadName !== "Sir" ? `${leadName} ji` : "ji";
  if (interestedModel) {
    return `Namaste ${name}! Main Sakshi, Shubham Motors se. Kya aapne ${interestedModel} le li ya abhi bhi soch rahe hain?`;
  }
  if (followupReason) {
    return `Namaste ${name}! Main Sakshi, Shubham Motors se. ${followupReason} — pehle ye bataiye, bike le li ya abhi consider kar rahe hain?`;
  }
  return `Namaste ${name}! Main Sakshi bol rahi hoon Shubham Motors se. Aapki enquiry ka follow-up tha — bike le li ya abhi dekh rahe hain?`;
}

/** System-prompt block injected on follow-up calls. */
export function buildFollowUpCallPromptBlock(
  profile: LeadProfile | undefined,
  priorCallCount: number,
  lastTranscriptSnippet?: string | null,
): string {
  if (priorCallCount < 1 && !profile?.lastCallSummary) return "";

  const known: string[] = [];
  if (profile?.name) known.push(`Name: ${profile.name}`);
  if (profile?.interestedModel) known.push(`Model: ${profile.interestedModel}`);
  if (profile?.buyingTimeline) known.push(`Buying timeline: ${profile.buyingTimeline}`);
  if (profile?.notes) known.push(`Notes: ${profile.notes.slice(0, 200)}`);

  const memory = lastTranscriptSnippet?.trim()
    ? lastTranscriptSnippet.slice(-400)
    : profile?.lastCallSummary?.slice(0, 400) ?? "";

  return `
╔══ FOLLOW-UP CALL (call #${priorCallCount + 1}) — PRIORITY OVERRIDE ══╗
This is a RETURN call. Follow these even if they conflict with normal discovery rules.

🚫 DO NOT RE-ASK if already known: name, budget, segment, interested model.
✅ START by asking: "Kya aapne bike le li since last call?" — if YES, handle outcome warmly.
✅ If NO: CONTINUE from last conversation — do NOT restart full discovery.
✅ If timeline unknown, ask naturally: "Kab tak lena plan hai — is hafte, mahine, ya festival ke baad?"
✅ Be warm — like continuing an old conversation, not a cold call.

${known.length ? `KNOWN FROM CRM:\n${known.map((k) => `• ${k}`).join("\n")}` : ""}
${memory ? `\nMEMORY FROM LAST CALL (use this, don't re-ask):\n"${memory}"` : ""}
╚═══════════════════════════════════════════════════════════════════════╝`;
}

/** Outbound dial mode — reference agent.py OUTBOUND CALL MODE block. */
export function buildOutboundCallPromptBlock(followupReason?: string | null): string {
  return `
╔══ OUTBOUND CALL MODE ══╗
YOU called the customer — they did not call you.
• First confirm they can talk: "Kya abhi 2 minute baat kar sakte hain?"
• Be direct — you have a reason: ${followupReason ?? "prior Hero bike enquiry / scheduled follow-up"}
• Goal: showroom visit OR exact callback time OR confirm buying timeline for auto follow-up
• Handle "kyun call kiya?" → "Aapki Hero enquiry thi, main timeline confirm kar rahi thi."
╚════════════════════════╝`;
}
