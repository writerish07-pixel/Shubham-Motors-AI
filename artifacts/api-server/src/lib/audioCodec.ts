/**
 * Pure JS audio codec helpers.
 * Exotel Voicebot streams G.711 μ-law 8kHz 8-bit mono.
 * Sarvam STT expects WAV 16kHz 16-bit mono.
 * Sarvam TTS returns WAV (variable rate) 16-bit mono.
 */

// ── Pre-computed μ-law decode table ──────────────────────────────────────────
const MULAW_DECODE = new Int16Array(256);
(function () {
  for (let i = 0; i < 256; i++) {
    let mulaw = ~i & 0xff;
    const sign = mulaw & 0x80;
    const exp = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exp;
    sample -= 0x84;
    MULAW_DECODE[i] = sign ? -sample : sample;
  }
})();

/** Decode μ-law bytes → signed 16-bit PCM samples */
export function mulawToS16(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = MULAW_DECODE[buf[i]!]!;
  return out;
}

/** Encode signed 16-bit PCM samples → μ-law bytes */
export function s16ToMulaw(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i]!;
    let sign = 0;
    if (s < 0) { sign = 0x80; s = -s; }
    s = Math.min(s + 0x84, 32767);
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
    const mantissa = (s >> (exp + 3)) & 0x0f;
    out[i] = (~(sign | (exp << 4) | mantissa)) & 0xff;
  }
  return out;
}

/** Biquad low-pass filter (Butterworth Q=0.707), applied twice for steeper rolloff. */
function lowPass(input: Int16Array, cutoffHz: number, sampleRate: number): Int16Array {
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosw = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * 0.7071);
  const a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0;
  const b1 = (1 - cosw) / a0;
  const b2 = (1 - cosw) / 2 / a0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;

  const out = new Int16Array(input.length);
  // First pass
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(y0)));
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  // Second pass for ~24 dB/octave rolloff
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  for (let i = 0; i < out.length; i++) {
    const x0 = out[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(y0)));
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

/**
 * Linear resampler with anti-aliasing for downsampling.
 * When downsampling, applies a 3400 Hz low-pass first (telephone band) to avoid aliasing.
 */
export function resample(input: Int16Array, fromHz: number, toHz: number): Int16Array {
  if (fromHz === toHz) return input;

  // Anti-alias filter BEFORE downsampling — critical to prevent metallic distortion
  const source = fromHz > toHz
    ? lowPass(input, Math.min(toHz / 2 - 200, 3400), fromHz)
    : input;

  const ratio = fromHz / toHz;
  const outLen = Math.floor(source.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = source[idx] ?? 0;
    const b = source[idx + 1] ?? a;
    out[i] = Math.round(a + frac * (b - a));
  }
  return out;
}

/** Build a minimal 16-bit mono WAV file from PCM samples */
export function buildWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataLen = pcm.length * 2;
  const buf = Buffer.allocUnsafe(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);          // block align
  buf.writeUInt16LE(16, 34);         // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, 44 + i * 2);
  return buf;
}

/** Parse a WAV file → PCM samples + sample rate */
export function parseWav(buf: Buffer): { pcm: Int16Array; sampleRate: number } {
  let offset = 12;
  let sampleRate = 8000;
  let dataOffset = 44;
  let dataLen = buf.length - 44;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      sampleRate = buf.readUInt32LE(offset + 12);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLen = Math.min(size, buf.length - dataOffset);
      break;
    }
    offset += 8 + (size % 2 === 0 ? size : size + 1);
  }

  const n = Math.floor(dataLen / 2);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(dataOffset + i * 2);
  return { pcm, sampleRate };
}

/** RMS energy of samples (0–1 range, normalised to 32768) */
export function rmsEnergy(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i]! / 32768) ** 2;
  return Math.sqrt(sum / samples.length);
}
