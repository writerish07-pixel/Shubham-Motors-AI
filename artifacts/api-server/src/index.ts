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
  startScheduler();
});
