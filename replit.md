# Shubham Motors AI (Sakshi)

Hindi/Hinglish voice sales agent and dealer CRM for Shubham Motors (Hero MotoCorp, Jaipur). Customers call or get called back; Sakshi discovers intent, quotes real on-road prices and precomputed EMIs, books test rides, and writes the CRM. After the call: WhatsApp summary, follow-up scheduling, relationship/revenue scores.

See `docs/ROADMAP.md` for the product map. `docs/WHAT_I_NEED.md` is the production cutover checklist (Fly.io Mumbai, secrets, ₹2/min). `docs/COST_AND_DEPLOY.md` is the cost model. `docs/PRODUCTION_AUDIT.md` is the August 2026 market + macro/micro audit.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API + voice WebSocket (port 5000)
- `pnpm --filter @workspace/shubham-motors run dev` — dealer CRM
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-server test` — api-server unit tests (`node:test`)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only; then republish for prod)
- Required env: `DATABASE_URL` — Postgres connection string
- Also required for a real call: `ADMIN_TOKEN`, `SARVAM_API_KEY`, Exotel credentials, `PORT`
- Recommended: `PUBLIC_BASE_URL`, `OPENAI_API_KEY`, `STREAM_SECRET`, `CORS_ORIGINS`, `SALES_TRANSFER_NUMBER`
- Production host: Fly.io Mumbai — `docs/COST_AND_DEPLOY.md`. Do not deploy this app on Replit.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + `ws` (Exotel Voicebot at `/call/stream`)
- Voice: Sarvam STT/TTS (Whisper STT fallback), OpenAI LLM
- Telephony / messaging: Exotel, WhatsApp via BotSpace
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Web CRM: React 19 + Vite + TanStack Query + wouter
- Build: esbuild (CJS bundle) for the API; Vite for the CRM

## Where things live

| Path | Source of truth for |
|------|---------------------|
| `lib/db/src/schema/` | Data model (`leads`, `calls`, `followups`, `knowledge`, `campaigns`, `contacts`) |
| `lib/api-spec/openapi.yaml` | HTTP API contract (keep in sync with Express routes, then codegen) |
| `artifacts/api-server/src/lib/callStream.ts` | Live voice turn loop |
| `artifacts/api-server/src/lib/callFinalize.ts` | Single post-call CRM + WhatsApp + follow-up path |
| `artifacts/api-server/src/lib/openai.ts` | System prompt, KB merge, call analysis |
| `artifacts/api-server/src/lib/relationshipIntel.ts` | Deterministic relationship/revenue scores |
| `artifacts/api-server/src/lib/scheduler.ts` | Auto-dialer and outbound retry state machine |
| `artifacts/shubham-motors/src/` | Dealer dashboard UI |
| `.agents/memory/` | Invariants that typecheck will not catch |

## Architecture decisions

- **Default Hero catalog is the floor.** `buildSystemPrompt()` always includes `DEFAULT_HERO_KNOWLEDGE` and only appends admin KB. A `knowledge \|\| DEFAULT` fallback once wiped prices in production.
- **LLM never does EMI math.** Precomputed table (9% p.a., fixed downs/tenures) is injected; the model must read it verbatim.
- **One post-call writer.** `callFinalize.ts` is used by the WebSocket path so CRM fields, follow-ups, and WhatsApp cannot diverge from a second webhook writer.
- **Outbound personalization is easy to ship inert.** ExoML must pass `direction`; context map is keyed by last-10 digits on both scheduler and `callStream`.
- **Single-instance by design today.** Circuit breaker, KB cache, and outbound context are in-memory. Redis is required before a second process.
- **Additive schema only.** New lead columns are nullable/defaulted. After any schema edit, `pnpm --filter @workspace/db run push` on dev then republish — a missing column has caused silent dead-air (lead SELECT throws before the greeting).

## Product

- Inbound and outbound voice (Hindi/Hinglish) on Exotel
- Discovery → model recommend → price/EMI → test-ride CTA or transfer to sales/finance
- CRM: leads, calls, follow-ups, campaigns, knowledge, contacts
- Auto-dialer with retries and WhatsApp fallback; DND and lost-deal hard stops
- Relationship, purchase-stage, persona, probability, and revenue scores after every call
- Dealer command center for pipeline, dialer, and knowledge review

## User preferences

- Do not rebuild working modules; extend them. Preserve APIs and CRM compatibility.
- Forget a rigid 30/70 talk-time rule if it truncates the closing CTA — drive the sale.
- Never copy an uploaded `_v3` voice-pipeline file wholesale; diff both ways first (some drops are older forks).

## Gotchas

- After adding a Drizzle column: push schema on **dev**, verify the lead-lookup query, then republish. `/healthz` does not touch `leads`, so it will stay green while calls are dead.
- Thinking fillers must chain through `playChain` (not fire-and-forget) or PCM overlaps.
- Lost-deal must cancel follow-ups, not only set `status = "lost"`.
- Unknown Exotel statuses must stay non-terminal (`in_progress`), never `failed` — the stale-dialing reaper recovers true unknowns.
- `interestedModel` is COALESCE-fill only; other CRM fields are last-write-wins.
- OpenAPI currently lags runtime analytics/scheduler routes; prefer spec + codegen over ad-hoc `fetch`.

## Pointers

- Roadmap: `docs/ROADMAP.md`
- What I need from you (Fly + secrets + ₹2/min): `docs/WHAT_I_NEED.md`
- AWS RDS (Mumbai) create steps: `docs/AWS_RDS.md`
- Cost and deploy: `docs/COST_AND_DEPLOY.md`
- Production-grade audit (market + gaps): `docs/PRODUCTION_AUDIT.md`
- Growth OS increment: `docs/GROWTH_OS_V2.md`
- Hardening report: `docs/PRODUCTION_HARDENING.md`
- Agent invariants: `.agents/memory/MEMORY.md`
