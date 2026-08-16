/**
 * Ensures every agent turn ends with a contextual sales follow-up question.
 * Kills dead-end replies and long silent gaps on live calls.
 */

import type { ConvStage, DiscoverySignals } from "./openai";
import { buyingTimelineQuestion } from "./buyingTimeline";

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
  const model = s.interestedModel ?? "";
  const combined = `${customer} ${model}`.toLowerCase();

  if (/cruise|glamour|dss|drs|centro|क्रूज|ग्लैमर/i.test(combined)) {
    if (!/dss|drs/i.test(customer)) {
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
    if (model) return `${model} की टेस्ट राइड कब ठीक रहेगी?`;
    return "कौन सा वेरिएंट आपको सूट करेगा?";
  }

  if (/feature|mileage|spec|engine|warranty|माइलेज/i.test(customer)) {
    if (model) return "शोरूम पर देखना चाहेंगे या पहले वॉट्सऐप पर डिटेल भेज दूँ?";
    return "रोज़ कितने किलोमीटर चलते हैं — उसी हिसाब से मॉडल बताऊँगी?";
  }

  if (stage === "booking" || stage === "ready") {
    return "टेस्ट राइड बुक कर दूँ — शनिवार सुबह या शाम?";
  }
  if (stage === "planning" || (!s.buyingTimeline && (ctx.turn ?? 0) >= 3 && (s.segment || s.interestedModel))) {
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

  if (!s.segment) return "पहले बताइए — स्कूटर चाहिए या बाइक?";
  if (!s.km) return "रोज़ लगभग कितने किलोमीटर चलना पड़ता है?";
  if (s.segment?.startsWith("scooter") && s.familyUse === undefined) {
    return "सिर्फ़ आप चलाएँगे या परिवार के साथ भी?";
  }
  if (!s.budget) return "कैश में लेंगे या ई एम आई पर?";
  if (!s.interestedModel) {
    if (s.segment === "125cc") {
      return "एक सौ पच्चीस सीसी में स्टाइल ग्लैमर या स्पोर्टी एक्सट्रीम — क्या पसंद है?";
    }
    if (s.segment?.startsWith("scooter")) {
      return "परिवार के लिए डेस्टिनी या स्पोर्टी ज़ूम — कौन सा ट्राई करें?";
    }
    if (s.segment === "100cc") return "माइलेज के लिए एच एफ डिलक्स या आराम के लिए स्प्लेंडर — कौन सा?";
    return "कौन सा मॉडल नाम से देख रहे हैं?";
  }

  if (model) return "टेस्ट राइड के लिए कब आना ठीक रहेगा?";
  return "और क्या जानना है — कीमत, ई एम आई, या टेस्ट राइड?";
}

/**
 * Live call #12 spoke only "कोई बात नहीं" because we cut after sentence 1.
 * Keep going until we have a question, two sentences, or a long enough turn.
 */
export function shouldSpeakAnotherSentence(spokenSoFar: string, attempted: number): boolean {
  if (attempted >= 2) return false;
  if (attempted >= 1 && endsWithQuestion(spokenSoFar)) return false;
  if (attempted >= 1 && spokenSoFar.replace(/\s+/g, " ").trim().length >= 140) return false;
  return true;
}

/** Append a follow-up question when the reply ends without one. */
export function ensureSalesFollowUp(reply: string, ctx: FollowUpContext): string {
  const trimmed = reply.trim();
  if (!trimmed || /^\s*\[TRANSFER/i.test(trimmed)) return reply;
  if (endsWithQuestion(trimmed)) return reply;

  const followUp = pickContextualFollowUp(ctx);
  const base = trimmed.replace(/[.।]\s*$/, "");
  return `${base}. ${followUp}`;
}

/** For streaming TTS — return a separate short sentence if the full reply lacks a question. */
export function getMissingFollowUpSentence(fullReply: string, ctx: FollowUpContext): string | null {
  if (!fullReply.trim() || /^\s*\[TRANSFER/i.test(fullReply)) return null;
  if (endsWithQuestion(fullReply)) return null;
  return pickContextualFollowUp(ctx);
}
