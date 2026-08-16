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
  const name = leadName !== "Sir" ? `${leadName} जी` : "जी";
  if (interestedModel) {
    return `नमस्ते ${name}! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से। क्या आपने ${interestedModel} ले ली या अभी सोच रहे हैं?`;
  }
  if (followupReason) {
    return `नमस्ते ${name}! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से। ${followupReason} — पहले यह बताइए, बाइक ले ली या अभी देख रहे हैं?`;
  }
  return `नमस्ते ${name}! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से। आपकी enquiry का follow-up था — बाइक ले ली या अभी देख रहे हैं?`;
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
• LEAD WITH NEW INFORMATION — an offer, stock arrival, price/EMI update, or their stated timeline coming due. NEVER say "bas follow-up kar rahi thi" or "just checking in" — a call without news feels like spam and gets cut.
• Goal: showroom visit OR exact callback time OR confirm buying timeline for auto follow-up
• Handle "kyun call kiya?" → "Aapki Hero enquiry thi, main timeline confirm kar rahi thi."
• Respect the 2 minutes you asked for — get to the point fast; never stretch a permission-based call past ~4 minutes.
╚════════════════════════╝`;
}
