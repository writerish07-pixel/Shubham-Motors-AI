# Deploy off Replit + ₹2 / minute call cost

## Where it runs now vs next

Replit GCE (`[deployment] router = application`) is **removed**. Voice needs a process that never sleeps: Exotel opens `wss://…/call/stream` for the whole call.

**Chosen host: Fly.io.** Prefer region `bom` (Mumbai). GitHub Launch currently fails there (`no capacity`; Mumbai often needs a paid Fly plan), so `fly.toml` ships `primary_region = "sin"` (Singapore) — next closest, and this Exotel account is already Singapore. One always-on 2 GB VM serves API + WebSocket + CRM. After a paid Fly org, move with `fly scale count 1 --region bom`.

Fallback: `docker compose` on a Mumbai/Bangalore VPS (`docker-compose.yml`).

Not used: Cloud Run / Lambda / Replit Autoscale — cold start = dead air on the first greeting.

Cutover checklist and secrets: **`docs/WHAT_I_NEED.md`**. I cannot deploy until Fly (or SSH) + env vars are in your hands.

```bash
# after fly auth and secrets
fly launch --copy-config --yes     # first time only; app name is shubham-motors-ai
fly secrets set DATABASE_URL=... ADMIN_TOKEN=... SARVAM_API_KEY=... # etc
fly deploy
```

Point Exotel Voicebot at `wss://<app>.fly.dev/call/stream` (or your domain). Set `PUBLIC_BASE_URL=https://<host>`.

---

## ₹2 / connected minute — can we?

**Yes, only on this stack.** US “best” agents (Retell/Vapi/ElevenLabs/Realtime) quote **$0.12–0.25/min ≈ ₹10–21**. They cannot hit ₹2.

Indicative **ex-GST** variable cost for a 1-minute outbound call, `COST_MODE=strict`:

| Layer | Rate used | Typical 1 min outbound | Typical 1 min inbound |
|-------|-----------|------------------------|------------------------|
| Exotel | ₹0.90 out / ₹0.60 in (you must confirm) | ₹0.90 | ₹0.60 |
| Sarvam STT | ₹30/hour of **sent** audio (~15 s speech) | ₹0.13 | ₹0.13 |
| Sarvam TTS Bulbul **v2** | ₹15 / 10k chars (~300 chars) | ₹0.05 | ₹0.05 |
| OpenAI **gpt-4o-mini** | ~2–3 turns, fat prompt, ~8k in / 120 out | ₹0.35 | ₹0.35 |
| **Total / min** | | **~₹1.43** | **~₹1.13** |

Headroom to ₹2 is for GST-on-vendors, retries, Whisper fallback, and a slightly talkative call.

### What blows the cap (do not enable)

| Choice | Why it misses ₹2 |
|--------|-------------------|
| **gpt-4o** on live turns | Same 3-min call ≈ ₹6+ LLM alone (`costMeter.test.ts`) |
| `COST_MODE=balanced` | Router promotes to gpt-4o on Honda/TVS/price/EMI — most sales turns |
| Sarvam Bulbul **v3** | 2× TTS (still small) |
| ElevenLabs TTS | ~₹6–10/min TTS |
| OpenAI Realtime / gpt-realtime | ~₹5+/min audio |
| Exotel outbound **> ₹1.20/min** | Telephony eats the whole budget |
| Hosting on a huge VM with 200 min/month | Amortized infra ≠ the ₹2 *call* cap; keep Fly ~$12–25/mo and measure vendors separately |

### How the repo enforces it

- Default **`COST_MODE=strict`**: every LLM turn is `gpt-4o-mini`. Fast-path / KB answers stay ₹0 LLM.
- TTS model stays **`bulbul:v2`** (`SARVAM_TTS_MODEL`).
- Each hang-up logs `{ cost: { perMinInr, totalInr, overBudget, … } }`. Alert if `overBudget`.
- Replace `COST_EXOTEL_*_INR_PER_MIN` with **your** rate card so the log is real, not a brochure.

GST 18% is billed by Exotel/Sarvam on top. If you need **₹2 inclusive of GST**, Exotel outbound must be ~₹0.70 or we cut LLM turns further (more fast-path).

---

## App shape on the new host

One container, port 8080:

- `POST/GET /api/*` — CRM API (token)
- `GET /api/healthz` — Fly health check
- `WS /call/stream` — Exotel Voicebot
- `GET /*` — dealer CRM (Vite build)

No second Replit “web” artifact.
