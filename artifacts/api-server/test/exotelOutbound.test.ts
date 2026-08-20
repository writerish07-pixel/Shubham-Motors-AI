import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOutboundCallParams, customerE164, streamWssUrl } from "../src/lib/exotel";
import { shouldCloseVoicebotForTransfer } from "../src/lib/humanTransfer";

test("outbound rings the customer first — never the ExoPhone hunt group", () => {
  const p = buildOutboundCallParams({
    customerPhone: "9876543210",
    virtualNumber: "01411234567",
    webhookBaseUrl: "https://shubham-motors-ai.fly.dev",
  });
  assert.equal(p.get("From"), "+919876543210");
  assert.equal(p.get("CallerId"), "01411234567");
  assert.equal(p.get("To"), null);
  assert.equal(p.get("TimeOut"), "30");
  assert.equal(p.get("StreamType"), "bidirectional");
  assert.equal(p.get("StreamUrl"), "wss://shubham-motors-ai.fly.dev/call/stream");
  assert.equal(p.get("Url"), "https://shubham-motors-ai.fly.dev/api/webhooks/exotel/inbound");
  assert.doesNotMatch(p.get("StreamUrl") ?? "", /\?/);
});

test("customerE164 and streamWssUrl stay PSTN-safe", () => {
  assert.equal(customerE164("+91 98765 43210"), "+919876543210");
  assert.equal(streamWssUrl("https://shubham-motors-ai.fly.dev/"), "wss://shubham-motors-ai.fly.dev/call/stream");
});

test("Voicebot WS closes only when a salesperson number was actually queued", () => {
  assert.equal(shouldCloseVoicebotForTransfer(true, 1), true);
  assert.equal(shouldCloseVoicebotForTransfer(true, 2), true);
  assert.equal(shouldCloseVoicebotForTransfer(false, 0), false);
  assert.equal(shouldCloseVoicebotForTransfer(true, 0), false);
});
