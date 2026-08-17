/**
 * STT normalisation for product/feature questions on phone calls.
 * Whisper/Sarvam often garble "Glamour" and "cruise control" beyond modelRouter aliases.
 */

const PRODUCT_ALIASES: Array<[RegExp, string]> = [
  [/\bgalemar\b/gi, "Glamour"],
  [/\bgalaimer\b/gi, "Glamour"],
  [/\bglemor\b/gi, "Glamour"],
  [/\bglaimer\b/gi, "Glamour"],
  [/\bvan\s+toti\s+faikh\b/gi, "125"],
  [/\bvan\s+twenty\s+five\b/gi, "125"],
  [/\btoti\s+faikh\b/gi, "125"],
  [/\bcruise\s*control\b/gi, "cruise control"],
  [/\bcruis\s*control\b/gi, "cruise control"],
  [/\bkruiz\s*control\b/gi, "cruise control"],
  [/\bkul\s*centro\b/gi, "cruise control"],
  [/\bkul\s*santro\b/gi, "cruise control"],
  [/\bcentro\s*lata\b/gi, "cruise control"],
  [/\bsantro\s*lata\b/gi, "cruise control"],
  [/\bकुल\s*संट्रो\b/g, "cruise control"],
  [/\bसंट्रो\s*लाता\b/g, "cruise control"],
  [/\bक्रूज़?\s*कंट्रोल\b/g, "cruise control"],
  [/\bfinance\s*ap+tion\b/gi, "finance option"],
  [/\bfinancing\s*ap+tion\b/gi, "finance option"],
  [/एच\s*एफ\s*डीलक्स/g, "HF Deluxe"],
  [/एच\s*[एसस]\s*डीलक्स/g, "HF Deluxe"],
  [/एचएफ\s*डीलक्स/g, "HF Deluxe"],
  [/एचएफडी/g, "HF Deluxe"],
  [/डीलक्स\s*प्रो/g, "HF Deluxe Pro"],
  [/सुपर\s*स्प्लेंडर/g, "Super Splendor"],
  [/डेस्टिनी/g, "Destini"],
  [/ज़ूम|जूम/g, "Xoom"],
];

export function normalizeProductStt(text: string): string {
  let t = text;
  for (const [re, rep] of PRODUCT_ALIASES) t = t.replace(re, rep);
  return t;
}

/** STT-heard variants of "cruise control" question. */
export function isCruiseControlQuestion(text: string): boolean {
  return /cruise\s*control|cruis|kruiz|centro|santro|संट्रो|क्रूज|कंट्रोल|kontrol/i.test(text);
}

export function mentionsGlamour(text: string): boolean {
  return /glamour|galemar|glaimer|glemor|ग्लैमर/i.test(text);
}

export function isFeatureAvailabilityQuestion(text: string): boolean {
  return /aata hai|aati hai|available|मिलता|आता|hai kya|है क्या|lata hai|लाता|milta|मिलती/i.test(text);
}
