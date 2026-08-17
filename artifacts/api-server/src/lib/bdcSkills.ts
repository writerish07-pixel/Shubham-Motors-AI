/**
 * World-class BDC skills as executable next-step rules.
 * Prompt-only SPIN / LAER / assumptive close was ignored on live calls
 * (call 18 restarted discovery after they had already named Super Splendor).
 */

export function isStall(text: string): boolean {
  return /सोच के बता|soch ke bata|sochte hain|देखते हैं|dekhte hain|बात करके बता|ghar pe baat|घर पे बात|घर वालों|family se pooch|compare kar(?:ke|unga|ungi)?|baad mein dekh|बाद में देख|later think/i.test(
    text,
  );
}

/** Price / EMI / feature / test-ride — answer this before any discovery loop. */
export function isLiveBuyingQuestion(text: string): boolean {
  return /price|kitne|kimat|qeemat|कीमत|on.?road|rate|emi|finance|feature|mileage|spec|engine|warranty|माइलेज|टेस्ट राइड|test ride|डाउन|down\s*payment/i.test(
    text,
  );
}

export function assumptiveVisitClose(model?: string): string {
  return model
    ? `${model} की टेस्ट राइड कब ठीक रहेगी — आज शाम या कल सुबह?`
    : "टेस्ट राइड कब ठीक रहेगी — आज शाम या कल सुबह?";
}

export function alternativeClose(model?: string): string {
  return model
    ? `${model} की लिस्ट वॉट्सऐप कर दूँ, या आज शाम शोरूम आ जाएँ?`
    : "वॉट्सऐप पर कीमत भेज दूँ, या आज शाम शोरूम आ जाएँ?";
}

/** LAER explore+respond after a stall. Spoken reply should already have listened/acknowledged. */
export function laerStallFollowUp(model?: string): string {
  return model
    ? `फैसला रोक किसने रखा है — बजट, घर वाले, या और ब्रांड? ${model} आज शाम ट्राई कर लें तो क्लियर हो जाएगा।`
    : "फैसला रोक किसने रखा है — बजट, घर वाले, या और ब्रांड?";
}

export type SpinGap = "situation" | "problem_km" | "problem_family" | "implication_budget" | "need_payoff";

export function spinGap(signals: {
  segment?: string;
  km?: number;
  familyUse?: boolean;
  budget?: number;
  interestedModel?: string;
}): SpinGap {
  if (signals.interestedModel) return "need_payoff";
  if (!signals.segment) return "situation";
  if (!signals.km) return "problem_km";
  if (signals.segment.startsWith("scooter") && signals.familyUse === undefined) return "problem_family";
  if (!signals.budget) return "implication_budget";
  return "need_payoff";
}

export function spinFollowUp(
  signals: {
    segment?: string;
    km?: number;
    familyUse?: boolean;
    budget?: number;
    interestedModel?: string;
  },
  model?: string,
): string {
  switch (spinGap({ ...signals, interestedModel: model || signals.interestedModel })) {
    case "situation":
      return "पहले बताइए — स्कूटर चाहिए या बाइक?";
    case "problem_km":
      return "रोज़ लगभग कितने किलोमीटर चलना पड़ता है?";
    case "problem_family":
      return "सिर्फ़ आप चलाएँगे या परिवार के साथ भी?";
    case "implication_budget":
      return "कैश में लेंगे या ई एम आई पर?";
    case "need_payoff":
      if (model || signals.interestedModel) {
        return assumptiveVisitClose(model || signals.interestedModel);
      }
      if (signals.segment === "125cc") {
        return "एक सौ पच्चीस सीसी में स्टाइल ग्लैमर या स्पोर्टी एक्सट्रीम — क्या पसंद है?";
      }
      if (signals.segment?.startsWith("scooter")) {
        return "परिवार के लिए डेस्टिनी या स्पोर्टी ज़ूम — कौन सा ट्राई करें?";
      }
      if (signals.segment === "100cc") {
        return "माइलेज के लिए एच एफ डिलक्स या आराम के लिए स्प्लेंडर — कौन सा?";
      }
      return "कौन सा मॉडल नाम से देख रहे हैं?";
  }
}
