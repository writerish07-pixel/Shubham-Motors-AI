import express, { type Express } from "express";
import cors from "cors";
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

export default app;
