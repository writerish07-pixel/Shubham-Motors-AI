import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { requireApiAuth } from "./middlewares/auth";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// CORS: lock down to CORS_ORIGINS (comma-separated) when set; otherwise allow
// all (fine behind the shared same-origin proxy in dev).
const corsOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins, credentials: true } : {}));
// Wide JSON limit ONLY for the KB import route (full dev-KB JSON dumps).
// Mount before the global parser so this takes precedence for that one path.
app.use("/api/knowledge/import", express.json({ limit: "25mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Token gate for all /api/* routes EXCEPT /healthz and the telephony webhooks
// (Exotel callbacks carry no token). Accepts X-Admin-Token or Bearer.
app.use("/api", requireApiAuth);

app.use("/api", router);

export default app;
