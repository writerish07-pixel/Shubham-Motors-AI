// Make English brand/model words speakable by the Sarvam Hindi TTS engine.
// Without this, "Hero Xoom 125" gets rendered as gibberish to a customer's ear.
// We map English brand tokens → phonetic Devanagari and insert commas between
// list items so the voice has natural pauses.

const PRONOUNCE: Array<[RegExp, string]> = [
  // Engine displacement — bare "100cc" / "125 cc" tokens are unintelligible to
  // the Hindi TTS engine (it slurs the glued "cc"). Spell the number in Hindi
  // words + "सीसी" so it is crystal-clear on a phone call.
  [/\b100\s*cc\b/gi, "सौ सीसी"],
  [/\b110\s*cc\b/gi, "एक सौ दस सीसी"],
  [/\b125\s*cc\b/gi, "एक सौ पच्चीस सीसी"],
  [/\b150\s*cc\b/gi, "एक सौ पचास सीसी"],
  [/\b160\s*cc\b/gi, "एक सौ साठ सीसी"],
  [/\b200\s*cc\b/gi, "दो सौ सीसी"],
  [/\b210\s*cc\b/gi, "दो सौ दस सीसी"],
  [/\b350\s*cc\b/gi, "तीन सौ पचास सीसी"],
  [/\b(\d+)\s*cc\b/gi, "$1 सीसी"], // fallback for any other displacement
  [/\bcc\b/gi, "सीसी"],            // stray "cc" with no leading number

  // Brand
  [/\bHero\b/g, "हीरो"],
  [/\bMotoCorp\b/gi, "मोटोकॉर्प"],
  [/\bShubham Motors\b/gi, "शुभम मोटर्स"],

  // Bike model names
  [/\bSplendor\s*Plus\s*XTEC\s*2\.0\b/gi, "स्प्लेंडर प्लस एक्सटेक टू पॉइंट ज़ीरो"],
  [/\bSplendor\s*Plus\b/gi, "स्प्लेंडर प्लस"],
  [/\bSplendor\s*XTEC\b/gi, "स्प्लेंडर एक्सटेक"],
  [/\bSuper\s*Splendor\s*XTEC\b/gi, "सुपर स्प्लेंडर एक्सटेक"],
  [/\bSuper\s*Splendor\b/gi, "सुपर स्प्लेंडर"],
  [/\bSplendor\b/gi, "स्प्लेंडर"],
  [/\bHF\s*Deluxe\s*PRO\b/gi, "एच एफ डिलक्स प्रो"],
  [/\bHF\s*Deluxe\b/gi, "एच एफ डिलक्स"],
  [/\bHF\s*100\b/gi, "एच एफ वन हंड्रेड"],
  [/\bPassion\s*Plus\b/gi, "पैशन प्लस"],
  [/\bPassion\s*Pro\b/gi, "पैशन प्रो"],
  [/\bGlamour\s*X\b/gi, "ग्लैमर एक्स"],
  [/\bGlamour\b/gi, "ग्लैमर"],
  [/\bXtreme\s*125R\b/gi, "एक्सट्रीम वन ट्वेंटी फाइव आर"],
  [/\bXtreme\s*160R\s*4V\b/gi, "एक्सट्रीम वन सिक्सटी आर फोर वी"],
  [/\bXtreme\s*160R\b/gi, "एक्सट्रीम वन सिक्सटी आर"],
  [/\bXtreme\b/gi, "एक्सट्रीम"],
  [/\bXpulse\s*200\s*4V\b/gi, "एक्स पल्स टू हंड्रेड फोर वी"],
  [/\bXpulse\s*210\b/gi, "एक्स पल्स टू टेन"],
  [/\bXpulse\b/gi, "एक्स पल्स"],
  [/\bKarizma\s*XMR\b/gi, "करिज़्मा एक्स एम आर"],
  [/\bKarizma\b/gi, "करिज़्मा"],
  [/\bDestini\s*125\b/gi, "डेस्टिनी वन ट्वेंटी फाइव"],
  [/\bDestini\s*110\b/gi, "डेस्टिनी वन टेन"],
  [/\bDestini\s*Prime\b/gi, "डेस्टिनी प्राइम"],
  [/\bDestini\b/gi, "डेस्टिनी"],
  [/\bPleasure\s*Plus\s*XTEC\b/gi, "प्लेज़र प्लस एक्सटेक"],
  [/\bPleasure\s*Plus\b/gi, "प्लेज़र प्लस"],
  [/\bPleasure\b/gi, "प्लेज़र"],
  [/\bXoom\s*160\b/gi, "ज़ूम वन सिक्सटी"],
  [/\bXoom\s*125\b/gi, "ज़ूम वन ट्वेंटी फाइव"],
  [/\bXoom\s*110\b/gi, "ज़ूम वन टेन"],
  [/\bXoom\b/gi, "ज़ूम"],
  [/\bMaestro\b/gi, "मेस्ट्रो"],
  [/\bVida\b/gi, "विडा"],

  // Variant codes
  [/\bIBS\b/g, "आई बी एस"],
  [/\bABS\b/g, "ए बी एस"],
  [/\bDRS\b/g, "डी आर एस"],
  [/\bDSS\b/g, "डी एस एस"],
  [/\bXTEC\b/g, "एक्सटेक"],
  [/\bi3S\b/g, "आई थ्री एस"],

  // Common English finance / sales words → Hindi for cleaner TTS
  [/\bShowroom\b/g, "शोरूम"],
  [/\bEMI\b/g, "ई एम आई"],
  [/\bRTO\b/g, "आर टी ओ"],
  [/\bOBD-?2\b/gi, "ओ बी डी टू"],
  [/\bCIBIL\b/gi, "सिबिल"],
  [/\bWhatsApp\b/gi, "वॉट्सऐप"],

  // Mileage / speed units — read as letters otherwise ("k m p l")
  [/\bkmpl\b/gi, "किलोमीटर प्रति लीटर"],
  [/\bkm\s*\/\s*l\b/gi, "किलोमीटर प्रति लीटर"],
  [/\bkmph\b/gi, "किलोमीटर प्रति घंटा"],
  [/\b(\d+)\s*km\b/gi, "$1 किलोमीटर"],

  // Bank names
  [/\bHDFC\b/g, "एच डी एफ सी"],
  [/\bIDBI\b/g, "आई डी बी आई"],
  [/\bRBL\b/g, "आर बी एल"],
  [/\bHinduja\b/gi, "हिंदुजा"],
  [/\bFinCorp\b/gi, "फिनकॉर्प"],

  // Common phrases
  [/\btest\s*ride\b/gi, "टेस्ट राइड"],
];

// Insert a comma+space before "और" between bullet items / lists so the TTS
// engine produces a clean pause (otherwise model names blur together).
function softenLists(text: string): string {
  // "Splendor, HF Deluxe और Passion" → already has commas; if not, add them
  // Replace " | " separators with " , "
  let t = text.replace(/\s*\|\s*/g, ", ");
  // Normalise multiple spaces
  t = t.replace(/[ \t]{2,}/g, " ");
  // Insert a tiny pause after every comma (already natural for TTS)
  return t;
}

// Strip Markdown/formatting so the TTS engine never speaks symbols aloud.
// The LLM sometimes emits **bold**, numbered lists ("1.", "2.") or bullets;
// without this the voice literally said "asterisk asterisk" on a live call.
function stripMarkdown(text: string): string {
  let t = text;
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");        // **bold**
  t = t.replace(/\*([^*\n]+)\*/g, "$1");           // *italic*
  t = t.replace(/__([^_]+)__/g, "$1");             // __bold__
  t = t.replace(/`([^`]+)`/g, "$1");               // `code`
  t = t.replace(/(^|\n)\s*#{1,6}\s*/g, "$1");      // # headings
  t = t.replace(/(^|\n)\s*\d+[.)]\s+/g, "$1");     // "1." / "2)" list markers
  t = t.replace(/(^|\n)\s*[-•·*]\s+/g, "$1");      // "- " / "• " / "* " bullets
  t = t.replace(/[*`#>]/g, " ");                    // any stray symbols left (keep _ to not corrupt tokens)
  return t;
}

export function prepareTtsText(text: string): string {
  let t = stripMarkdown(text);
  for (const [re, rep] of PRONOUNCE) t = t.replace(re, rep);
  t = softenLists(t);
  return t.trim();
}
