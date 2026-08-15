# Create the AWS Postgres database (Mumbai)

Sakshi uses **PostgreSQL 16** (`DATABASE_URL`). Put it in **Asia Pacific (Mumbai) `ap-south-1`** so Fly.io `bom` and Exotel/Jaipur stay in-region.

Use **Amazon RDS** (not DynamoDB, not Aurora Serverless, not Lightsail unless you already live there). I cannot click Create in your AWS account — use the values below.

---

## Console steps

1. Open [AWS RDS](https://ap-south-1.console.aws.amazon.com/rds/home?region=ap-south-1).  
   Top-right region **must** be **Asia Pacific (Mumbai) ap-south-1**. If it says N. Virginia / Oregon, switch.

2. **Create database** → **Standard create**.

3. Engine:
   - Engine type: **PostgreSQL**
   - Version: **16.x** (latest 16 is fine; do not pick 13/14/15 unless you must)

4. Templates:
   - **Free tier** if the account is still eligible (first 12 months)
   - otherwise **Dev/Test**

5. Settings:

   | Field | Value |
   |-------|--------|
   | DB instance identifier | `shubham-motors-ai` |
   | Master username | `sakshi` |
   | Master password | generate 20+ chars, **save it now** (AWS will not show it again unless you tick auto-generate and use Secrets Manager) |

6. Instance:
   - Class: **`db.t4g.micro`** (Graviton, cheapest). If missing, **`db.t3.micro`**.
   - Do **not** pick Multi-AZ yet (~2× cost).

7. Storage:
   - gp3, **20 GiB**
   - Storage autoscaling: on, max **50 GiB**

8. Connectivity (this is the part that breaks Fly if wrong):

   | Field | Value |
   |-------|--------|
   | Compute resource | Don’t connect an EC2 compute resource |
   | VPC | default |
   | Public access | **Yes** — Fly.io is not inside your VPC |
   | VPC security group | **Create new** named `sakshi-pg-fly` |
   | Availability Zone | No preference |
   | RDS Proxy | off |
   | Certificate authority | default |

9. Additional configuration:
   - Initial database name: **`sakshi`** (if you skip this, you only get `postgres` and must create `sakshi` later)
   - Backup retention: **7 days**
   - Encryption: default (on)
   - Enhanced monitoring: off (saves money)
   - Delete protection: **on** for production

10. **Create database**. Wait 5–10 minutes until Status = **Available**.

---

## Security group (port 5432)

RDS → database → **Connectivity & security** → security group `sakshi-pg-fly` → Inbound:

| Type | Port | Source | Why |
|------|------|--------|-----|
| PostgreSQL | 5432 | `0.0.0.0/0` | Temporary so Fly can connect **this week** |

Lock this later to Fly’s egress IPs (`fly ips list` / Fly docs “static egress”). Do not leave `0.0.0.0/0` forever. Username + long password + `sslmode=require` is the other half of the lock.

---

## Connection string

On the RDS page copy **Endpoint** (looks like):

`shubham-motors-ai.XXXXXX.ap-south-1.rds.amazonaws.com`

Build (URL-encode the password if it has `@`, `#`, `%`, `/`):

```text
postgresql://sakshi:YOUR_PASSWORD@ENDPOINT:5432/sakshi?sslmode=require
```

That entire string is `DATABASE_URL`.

Fly/Node must trust Amazon's RDS CA (not in the public store). The image ships `lib/db/certs/ap-south-1-bundle.pem` as `NODE_EXTRA_CA_CERTS`. Without that, `/api/healthz` shows `"db":"error"` even when the password is correct.

Paste it into Fly after the app exists:

```bash
fly secrets set DATABASE_URL="postgresql://sakshi:...@....rds.amazonaws.com:5432/sakshi?sslmode=require"
```

Then the schema must be applied once (empty RDS has no `leads` table):

```bash
DATABASE_URL='postgresql://...' pnpm --filter @workspace/db run push
```

If you send me the URL privately, I can run the push from a one-off machine. **Do not put the password in the GitHub PR.**

---

## Cost (Mumbai, indicative)

| Item | Approx. |
|------|---------|
| db.t4g.micro + 20 GB | ~$12–18 / month (~₹1,000–1,500) |
| Multi-AZ | skip for now |
| Data transfer Fly↔RDS in-region | small |

This is **hosting**, not the ₹2/min call cap.

---

## What to send back

- [ ] Region is `ap-south-1`
- [ ] Endpoint hostname
- [ ] Database name `sakshi`
- [ ] Username `sakshi`
- [ ] Password (private)
- [ ] Public access = Yes
- [ ] Screenshot of Status = Available

I do not need AWS root keys.
