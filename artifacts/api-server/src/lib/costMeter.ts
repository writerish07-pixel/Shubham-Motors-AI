/**
 * Per-call cost estimate in INR — used to keep Sakshi under ₹2 / connected minute.
 *
 * Telephony dominates. STT/TTS (Sarvam) are cheap. gpt-4o is NOT — COST_MODE=strict
 * (gpt-4o-mini only) is required for the cap. Rates are env-overridable so the
 * log matches the dealer's actual Exotel card.
 */

export type CallDirection = "inbound" | "outbound";

export interface CostRates {
  usdInr: number;
  exotelInboundPerMin: number;
  exotelOutboundPerMin: number;
  sarvamSttPerHour: number;
  sarvamTtsPer10kChars: number;
  miniInputUsdPer1M: number;
  miniOutputUsdPer1M: number;
  premiumInputUsdPer1M: number;
  premiumOutputUsdPer1M: number;
}

export interface CallCostInput {
  durationSec: number;
  direction: CallDirection;
  sttAudioSec: number;
  ttsChars: number;
  llmMiniCalls: number;
  llmPremiumCalls: number;
  /** Conservative default: fat Hero+EMI system prompt ~8k tokens/turn */
  llmInputTokensPerCall?: number;
  llmOutputTokensPerCall?: number;
}

export interface CallCostBreakdown {
  telephonyInr: number;
  sttInr: number;
  ttsInr: number;
  llmInr: number;
  totalInr: number;
  perMinInr: number;
  overBudget: boolean;
}

const DEFAULT_RATES: CostRates = {
  usdInr: Number(process.env.COST_USD_INR ?? 85),
  exotelInboundPerMin: Number(process.env.COST_EXOTEL_INBOUND_INR_PER_MIN ?? 0.6),
  exotelOutboundPerMin: Number(process.env.COST_EXOTEL_OUTBOUND_INR_PER_MIN ?? 0.9),
  sarvamSttPerHour: 30,
  sarvamTtsPer10kChars: 15, // bulbul:v2 — v3 is 30 and will miss the cap
  miniInputUsdPer1M: 0.15,
  miniOutputUsdPer1M: 0.6,
  premiumInputUsdPer1M: 2.5,
  premiumOutputUsdPer1M: 10,
};

export function loadCostRates(): CostRates {
  return { ...DEFAULT_RATES };
}

export function budgetInrPerMin(): number {
  return Number(process.env.COST_ALERT_INR_PER_MIN ?? 2);
}

export function estimateCallCost(input: CallCostInput, rates: CostRates = loadCostRates()): CallCostBreakdown {
  const minutes = Math.max(input.durationSec, 1) / 60;
  const telRate = input.direction === "outbound" ? rates.exotelOutboundPerMin : rates.exotelInboundPerMin;
  const telephonyInr = minutes * telRate;

  const sttInr = (Math.max(input.sttAudioSec, 0) / 3600) * rates.sarvamSttPerHour;
  const ttsInr = (Math.max(input.ttsChars, 0) / 10_000) * rates.sarvamTtsPer10kChars;

  const inTok = input.llmInputTokensPerCall ?? 8_000;
  const outTok = input.llmOutputTokensPerCall ?? 120;
  const miniInr =
    ((input.llmMiniCalls * inTok) / 1_000_000) * rates.miniInputUsdPer1M * rates.usdInr +
    ((input.llmMiniCalls * outTok) / 1_000_000) * rates.miniOutputUsdPer1M * rates.usdInr;
  const premInr =
    ((input.llmPremiumCalls * inTok) / 1_000_000) * rates.premiumInputUsdPer1M * rates.usdInr +
    ((input.llmPremiumCalls * outTok) / 1_000_000) * rates.premiumOutputUsdPer1M * rates.usdInr;
  const llmInr = miniInr + premInr;

  const totalInr = telephonyInr + sttInr + ttsInr + llmInr;
  const perMinInr = totalInr / minutes;
  return {
    telephonyInr: round2(telephonyInr),
    sttInr: round2(sttInr),
    ttsInr: round2(ttsInr),
    llmInr: round2(llmInr),
    totalInr: round2(totalInr),
    perMinInr: round2(perMinInr),
    overBudget: perMinInr > budgetInrPerMin(),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class CallCostCounters {
  sttAudioSec = 0;
  ttsChars = 0;
  llmMiniCalls = 0;
  llmPremiumCalls = 0;
  readonly startedAt = Date.now();

  addSttSamples(sampleCount: number, sampleRate: number): void {
    if (sampleRate > 0 && sampleCount > 0) this.sttAudioSec += sampleCount / sampleRate;
  }

  addTtsText(text: string): void {
    this.ttsChars += text.length;
  }

  addLlmCall(tier: "mini" | "premium"): void {
    if (tier === "premium") this.llmPremiumCalls += 1;
    else this.llmMiniCalls += 1;
  }

  snapshot(direction: CallDirection, rates?: CostRates): CallCostBreakdown & { durationSec: number } {
    const durationSec = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    return {
      durationSec,
      ...estimateCallCost(
        {
          durationSec,
          direction,
          sttAudioSec: this.sttAudioSec,
          ttsChars: this.ttsChars,
          llmMiniCalls: this.llmMiniCalls,
          llmPremiumCalls: this.llmPremiumCalls,
        },
        rates,
      ),
    };
  }
}
