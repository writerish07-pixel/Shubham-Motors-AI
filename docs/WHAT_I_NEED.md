# What I need from you — production off Replit, under ₹2/min

I cannot finish a live cutover without the items below. Paste values in a private channel (not in the GitHub PR). Until **§1 + §2** land, the app stays in this repo only.

Cost rule: **variable cost per connected minute ≤ ₹2 (ex-GST)**. That only works with Exotel + Sarvam Bulbul **v2** + **gpt-4o-mini**. ElevenLabs, OpenAI Realtime, and gpt-4o-as-default will miss the cap.

---

## 1. Deploy account (blocker — I cannot press deploy without this)

Pick **one**. Recommended: **A**.

### A — Fly.io Mumbai (recommended)

Always-on VM in `bom`, HTTPS + WSS for Exotel, closest region to Jaipur / Sarvam / Exotel.

1. Create a Fly.io account: https://fly.io/app/sign-up  
2. Install CLI (`curl -L https://fly.io/install.sh | sh`) **or** send me a **Fly org invite** + a deploy token.  
3. Reply with:
   - [ ] Fly account email / org name  
   - [ ] `FLY_API_TOKEN` (deploy token) — add as GitHub secret `FLY_API_TOKEN` **or** paste to me privately  
   - [ ] Whether I should run `fly launch` and create `shubham-motors-ai` in **bom**  
4. Postgres (pick one):
   - [ ] **Neon** project in `aws-ap-south-1` (Mumbai) — create DB, send `DATABASE_URL`  
   - [ ] **Fly Postgres** in `bom` — I can create this if you give Fly token + say yes  
   - [ ] Existing Postgres URL (must be reachable from Fly Mumbai)

### B — Mumbai/Bangalore VPS instead

If you prefer a box you SSH into: AWS Lightsail Mumbai, DigitalOcean Bangalore, or Vultr Delhi. Send:

- [ ] SSH user@host + key (or invite my deploy key)
- [ ] A domain pointing at the box (see §3)
- [ ] I will use `docker compose` from this repo

**Do not use Replit, Cloud Run, or Lambda** for this app. Exotel Voicebot is a long-lived WebSocket; scale-to-zero kills the greeting.

---

## 2. Secrets (copy from Replit Secrets today)

Exact env names:

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | yes | Postgres, Mumbai if possible |
| `ADMIN_TOKEN` | yes | Long random string; CRM Settings must match |
| `SARVAM_API_KEY` | yes | Keep current key |
| `OPENAI_API_KEY` | yes | gpt-4o-mini must be enabled on the account |
| `EXOTEL_SID` | yes | |
| `EXOTEL_API_KEY` | yes | |
| `EXOTEL_API_TOKEN` | yes | |
| `EXOTEL_VIRTUAL_NUMBER` | yes | The ExoPhone customers see |
| `BOTSPACE_API_KEY` | for WhatsApp | |
| `BOTSPACE_PHONE_NUMBER_ID` | for WhatsApp | |
| `SALES_TRANSFER_NUMBER` | recommended | Fallback if CRM contacts empty |
| `STREAM_SECRET` | recommended | I will require it on `/call/stream` once you set it |
| `CORS_ORIGINS` | if CRM is on another domain | |

Also tell me: **are these keys still valid on Replit right now?** (yes/no)

---

## 3. Domain + TLS

- [ ] Production hostname, e.g. `sakshi.shubhammotors.in` or accept `*.fly.dev` for week 1  
- [ ] DNS access (Cloudflare / GoDaddy / whoever) so I can set A/AAAA or CNAME  
- [ ] `PUBLIC_BASE_URL=https://<that-host>` — Exotel webhooks **must** use this, not Replit

After DNS is live I will give you the three Exotel URLs to paste (inbound ExoML, status callback, Voicebot WSS).

---

## 4. Exotel production wiring (you click in their dashboard)

I cannot log into Exotel unless you invite me.

- [ ] **Exotel dashboard invite** (email: tell me which address to use) **or** screenshots of App Bazaar / applet  
- [ ] Voicebot / Passthru applet: stream URL will become `wss://<PUBLIC_BASE_URL host>/call/stream`  
- [ ] Status callback: `https://<host>/api/webhooks/exotel/status`  
- [ ] Connect URL: `https://<host>/api/webhooks/exotel/inbound`  
- [ ] Your **Exotel per-minute rate card** (inbound DID + outbound mobile), **ex-GST**  
  - Budget math fails if outbound is above **~₹0.90/min**. If your card is ₹1.20–1.80, say so — we either renegotiate Exotel or the ₹2 cap is impossible.  
- [ ] Confirm number type: landline DID vs 140-series promo vs 1600-series service  
- [ ] Optional: Exotel **DND/NCPR scrub** enabled on the account (needed for TRAI)  
- [ ] Optional: webhook **IP list** or shared secret if Exotel documents one  

---

## 5. WhatsApp (required for missed-call fallback under Meta rules)

Freeform text will fail outside the 24-hour window. I need **approved templates**:

- [ ] BotSpace / Meta WABA is live and attached to the dealership  
- [ ] Template: post-call summary (Hindi)  
- [ ] Template: brochure / model PDF  
- [ ] Template: missed-call / retry (“we tried calling…”)  
- [ ] Template names + language codes as approved  
- [ ] Opt-out keyword handling (STOP) — who owns it today?

If templates are not approved yet: **outbound WhatsApp must stay off** until they are. Voice can still go live.

---

## 6. Cost sign-off (₹2 / minute)

Reply yes/no:

- [ ] I accept **COST_MODE=strict** (gpt-4o-mini only, no gpt-4o on live turns). This is how we stay under ₹2.  
- [ ] I accept **Sarvam Bulbul v2** (not v3, not ElevenLabs).  
- [ ] I will paste **actual Exotel inbound + outbound ₹/min**.  
- [ ] Monthly volume guess: _____ connected minutes (so I can amortize Fly ~$12–25/mo). Below ~1,000 min/month, **hosting** can look >₹2/min even if vendors are cheap — hosting is separate from the ₹2 **call** cap.  
- [ ] Confirm ₹2 is **ex-GST**. Indian vendors add 18% GST on their invoices.

Do **not** ask for ElevenLabs or OpenAI Realtime if the cap stays ₹2. Those stacks run ~₹6–20/min.

---

## 7. Compliance / legal (India)

Without these, “production” is a demo that can get the ExoPhone listed.

- [ ] DLT Principal Entity ID (or “Exotel handles PE, here is the TM link”)  
- [ ] Consent source for outbound: website form / walk-in / BikeWale — **how is consent stored today?**  
- [ ] Legal sign-off: recording line (“Yeh call quality ke liye record hoti hai”)  
- [ ] Legal sign-off: **AI disclosure** in the greeting (TRAI direction). I have `AI_DISCLOSURE=0` until you say 1.  
- [ ] DND process: besides saying “call mat karo”, is there a register to import?  
- [ ] Call recording retention (days) and who can listen  
- [ ] DPDP: do we need a delete-my-data path at launch?

---

## 8. Dealership operating data

- [ ] Latest **on-road price list** (xlsx) dated ____  
- [ ] Current **stock** xlsx  
- [ ] Live **festival/offer** flyer if any  
- [ ] Showroom address, hours, maps link (confirm Lal Kothi, Tonk Road)  
- [ ] Sales transfer number(s) + finance bank numbers to put in CRM → Contacts  
- [ ] Who is on-desk 9:00–20:00 IST when Sakshi transfers?  
- [ ] BikeWale / BikeDekho / Facebook lead emails or webhooks (for speed-to-lead)

---

## 9. Access for me (optional but faster)

- [ ] GitHub org/repo write already used for this PR  
- [ ] Fly token / VPS SSH (§1)  
- [ ] Exotel collaborator  
- [ ] BotSpace collaborator  
- [ ] DNS  
- [ ] Neon / Postgres dashboard  

I will **not** log into Replit to copy secrets — export them yourself.

---

## 10. Go-live test window

- [ ] Two Indian mobiles I may call (and that may call the ExoPhone)  
- [ ] 30-minute window IST for: inbound greeting, “sporty mein”, 125cc list, transfer, outbound follow-up, WhatsApp template  
- [ ] Dealer GM who will click around the CRM after DNS is live  

---

## Minimum to do *anything* on a real phone

**§1 (Fly or VPS) + §2 (secrets) + §3 (PUBLIC_BASE_URL) + §4 (Exotel URLs) + §6 Exotel rate card.**

Everything else can follow in week 2. WhatsApp templates (§5) can wait if you accept “voice only” at cutover.

When you reply, use the checkboxes. I will then: create the Fly app, set secrets, `fly deploy`, give you the Exotel URL list, and you switch the applet off Replit.
