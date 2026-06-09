import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { startScheduler } from "./lib/scheduler";
import { setupVoicebotWS } from "./lib/callStream";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Create a plain HTTP server so the WebSocket server can share the same port
const server = http.createServer(app);

// Attach Exotel Voicebot WebSocket handler at /call/stream
setupVoicebotWS(server);

server.listen(port, () => {
  logger.info({ port }, "Server listening");
  if (!process.env.ADMIN_TOKEN) {
    logger.warn("ADMIN_TOKEN is not set — all /api routes (except webhooks) will return 503");
  }
  if (!process.env.SARVAM_API_KEY) {
    logger.warn("SARVAM_API_KEY is not set — voice STT/TTS will fail");
  }
  if (!process.env.DATABASE_URL) {
    logger.warn("DATABASE_URL is not set — database operations will fail");
  }
  startScheduler();
});
