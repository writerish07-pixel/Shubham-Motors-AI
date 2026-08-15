import express, { type Express } from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireApiAuth, isPublicApiPath } from "./middlewares/auth";

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
const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  corsOrigins.length > 0
    ? cors({ origin: corsOrigins, credentials: true })
    : cors(),
);
// Wide JSON limit ONLY for the KB import route (full dev-KB JSON dumps).
// Mount before the global parser so this takes precedence for that one path.
app.use("/api/knowledge/import", express.json({ limit: "25mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", (req, res, next) => {
  if (isPublicApiPath(req.path)) return next();
  return requireApiAuth(req, res, next);
});
app.use("/api", router);

const staticDir = process.env.STATIC_DIR;
if (staticDir && fs.existsSync(staticDir)) {
  app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/call")) return next();
    res.sendFile(path.join(staticDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });
  logger.info({ staticDir }, "Serving CRM static files");
}

export default app;
