export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Customer wants prior info repeated — not a new topic. */
export function detectRepeatRequest(text: string): boolean {
  return /dubara|dohra|phir\s*se|repeat|फिर\s*से|दोबारा|एक\s*बार\s*फिर|sun(?:ai|a)?\s*nahi|samajh\s*nahi|kya\s*bola|kya\s*kaha|clear\s*nahi|re-?explain|बत(?:ा|ा)?(?:ओ|इए)\s*फिर/i.test(
    text,
  );
}

export function buildRepeatInstruction(history: ChatTurn[]): string {
  const agentTurns = history
    .filter((h) => h.role === "assistant" && !/^\s*\[TRANSFER/i.test(h.content))
    .slice(-4);
  if (agentTurns.length === 0) return "";
  const snippets = agentTurns.map((t) => t.content.trim()).filter(Boolean);
  const focus = snippets[snippets.length - 1] ?? "";
  return (
    `\n╔══ REPEAT REQUEST — customer wants prior info again ══╗\n` +
    `Re-state the relevant part clearly (same facts, simpler words). ALWAYS include tenure if quoting EMI.\n` +
    `Most recent agent info to repeat:\n"${focus.slice(0, 500)}"\n` +
    `Do NOT restart finance discovery. Do NOT replay the finance opening script.\n` +
    `╚═══════════════════════════════════════════════════════╝`
  );
}

/** Use customer name occasionally — not every turn. */
export function formatAddressForm(leadName: string, turn: number): string {
  if (leadName === "Sir") return "aap";
  if (turn <= 2 || turn % 4 === 0) return `${leadName} ji`;
  return "aap";
}
