/**
 * Ensures every agent turn ends with a contextual sales follow-up question.
 * Kills dead-end replies and long silent gaps on live calls.
 */

import type { ConvStage, DiscoverySignals } from "./openai";
import { buyingTimelineQuestion } from "./buyingTimeline";
import { isAgentPromisingTransfer } from "./humanTransfer";
import { isGlamourFamily, isRejectingPreviousModel, liveModelForTurn, modelFamily } from "./liveModel";
import {
  assumptiveVisitClose,
  isLiveBuyingQuestion,
  isStall,
  laerStallFollowUp,
  spinFollowUp,
} from "./bdcSkills";

export interface FollowUpContext {
  signals?: DiscoverySignals;
  convStage?: ConvStage;
  turn?: number;
  customerText?: string;
  leadName?: string;
}

/** True if the reply already invites a customer response. */
export function endsWithQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // A question mark ANYWHERE means the reply already invites a response —
  // appending a second question ("...kab free rahenge? Main tab call karungi."
  // + "Scooter ya bike?") sounds scripted and pushy on a phone call.
  if (/[?？]/.test(t)) return true;

  const lastSentence = t.split(/[.!?।]\s*/).filter(Boolean).pop()?.trim() ?? t;
  return /(?:kya|kaun|kaunsa|kaunsi|kab|kahan|kitna|kitni|kitne|chahenge|chahte|chaahiy|bataiyega|bataiye|batao|plan|suit|theek lag|dekhna|dekh rahe|aayenge|lenge|soch rahe|karun|karu|book|convenient|pasand|try|compare|final|down\s*payment|emi|tenure|variant|drss?|dss)/i.test(
    lastSentence,
  ) || /(?:क्या|कौन|कब|कहाँ|कितना|कितनी|चाहेंगे|चाहते|बताइए|बताएंगे|आएंगे|सोच रहे|पसंद|वेरिएंट|डाउन)/.test(
    lastSentence,
  );
}

/** Pick the single best next question for this moment in the sale. */
export function pickContextualFollowUp(ctx: FollowUpContext): string {
  const s = ctx.signals ?? {};
  const stage = ctx.convStage ?? "connect";
  const customer = (ctx.customerText ?? "").toLowerCase();
  const model = liveModelForTurn(ctx.customerText ?? "", s.interestedModel);
  const family = modelFamily(model);

  // Call 17: never ask Glamour DSS vs DRS unless THIS turn's model is Glamour.
  // Skip if they already asked a buying question — variant can wait, the close cannot.
  if (isGlamourFamily(model) && !isRejectingPreviousModel(ctx.customerText ?? "")) {
    if (!/dss|drs/i.test(customer) && !/price|kitne|kimat|qeemat|कीमत|on.?road|emi|finance|टेस्ट राइड|test ride/i.test(customer)) {
      return "आप डी आर एस देख रहे हैं या क्रूज़ कंट्रोल वाला डी एस एस?";
    }
  }

  if (s.financeInterest) {
    if (/down|hajar|hazaar|lakh|lac|डाउन|हज़ार|लाख/i.test(customer)) {
      return "चौबीस महीने या छत्तीस — किस पर ई एम आई निकालूँ?";
    }
    if (model) {
      return `${model} के लिए कितना डाउन पेमेंट दे सकते हैं — मैं ई एम आई बता दूँ?`;
    }
    return "कितना डाउन पेमेंट सोच रहे हैं — मैं चौबीस और छत्तीस महीने की ई एम आई बता दूँ?";
  }

  if (/price|kitne|kimat|qeemat|कीमत|on.?road|rate/i.test(customer)) {
    if (model) return assumptiveVisitClose(model);
    return "कौन सा वेरिएंट आपको सूट करेगा?";
  }

  if (/feature|mileage|spec|engine|warranty|माइलेज/i.test(customer)) {
    if (model) return `${model} की ऑन-रोड बताऊँ या टेस्ट राइड बुक करूँ?`;
    return "रोज़ कितने किलोमीटर चलते हैं — उसी हिसाब से मॉडल बताऊँगी?";
  }

  // LAER: stall is an objection, not permission to end the call.
  if (isStall(ctx.customerText ?? "") && !isLiveBuyingQuestion(ctx.customerText ?? "")) {
    return laerStallFollowUp(model || undefined);
  }

  if (family === "HF Deluxe") {
    if (!/pro|drs/i.test(customer)) {
      return "एच एफ डिलक्स डी आर एस या प्रो — कौन सा देख रहे हैं? ऑन-रोड बता दूँ?";
    }
    return "एच एफ डिलक्स की टेस्ट राइड कब आएँगे — आज शाम या कल सुबह?";
  }

  if (stage === "booking" || stage === "ready") {
    return model
      ? `${model} की टेस्ट राइड बुक कर दूँ — शनिवार सुबह या शाम?`
      : "टेस्ट राइड बुक कर दूँ — शनिवार सुबह या शाम?";
  }
  if (stage === "planning" || (!s.buyingTimeline && (ctx.turn ?? 0) >= 3 && (s.segment || model))) {
    return buyingTimelineQuestion(model || undefined);
  }
  if (stage === "negotiating") {
    return "ई एम आई से आराम रहेगा या एक्सचेंज भी देखें?";
  }
  if (stage === "shortlisting" && model) {
    return `${model} की टेस्ट राइड कर लेंगे — कौन सा दिन आएँगे?`;
  }
  if (stage === "comparing") {
    return "आपके लिए सबसे ज़रूरी क्या है — माइलेज, स्टाइल, या ई एम आई?";
  }

  // Named model this call: SPIN Need-payoff = visit. Do not restart km discovery.
  if (model) {
    return assumptiveVisitClose(model);
  }

  return spinFollowUp(s, model || undefined);
}

/**
 * Live call #12 spoke only "कोई बात नहीं" because we cut after sentence 1.
 * Keep going until we have a question, two sentences, or a long enough turn.
 */
export function shouldSpeakAnotherSentence(spokenSoFar: string, attempted: number): boolean {
  if (isAgentPromisingTransfer(spokenSoFar)) return false;
  if (attempted >= 2) return false;
  if (attempted >= 1 && endsWithQuestion(spokenSoFar)) return false;
  if (attempted >= 1 && spokenSoFar.replace(/\s+/g, " ").trim().length >= 140) return false;
  return true;
}

/** Append a follow-up question when the reply ends without one. */
export function ensureSalesFollowUp(reply: string, ctx: FollowUpContext): string {
  const trimmed = reply.trim();
  if (!trimmed || /^\s*\[TRANSFER/i.test(trimmed) || isAgentPromisingTransfer(trimmed)) return reply;
  if (endsWithQuestion(trimmed)) return reply;

  const followUp = pickContextualFollowUp(ctx);
  const base = trimmed.replace(/[.।]\s*$/, "");
  return `${base}. ${followUp}`;
}

/** For streaming TTS — return a separate short sentence if the full reply lacks a question. */
export function getMissingFollowUpSentence(fullReply: string, ctx: FollowUpContext): string | null {
  if (!fullReply.trim() || /^\s*\[TRANSFER/i.test(fullReply) || isAgentPromisingTransfer(fullReply)) return null;
  if (endsWithQuestion(fullReply)) return null;
  return pickContextualFollowUp(ctx);
}
