import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOTSPACE_PUBLIC_API,
  botspaceMediaUrl,
  botspaceSessionUrl,
  botspaceTemplateUrl,
  normalizeWhatsAppPhone,
} from "../src/lib/whatsapp";

test("BotSpace URLs use public-api.bot.space and the Channel settings ID", () => {
  const channelId = "69ba3b443c58de2b169911a3";
  assert.equal(BOTSPACE_PUBLIC_API, "https://public-api.bot.space");
  assert.equal(
    botspaceSessionUrl(channelId),
    `https://public-api.bot.space/v1/${channelId}/message/send-session-message`,
  );
  assert.equal(
    botspaceTemplateUrl(channelId),
    `https://public-api.bot.space/v1/${channelId}/message/send-message`,
  );
  assert.equal(
    botspaceMediaUrl(channelId),
    `https://public-api.bot.space/v1/${channelId}/message/send-session-media-message`,
  );
});

test("normalizeWhatsAppPhone matches BotSpace +91 example", () => {
  assert.equal(normalizeWhatsAppPhone("8890589911"), "+918890589911");
  assert.equal(normalizeWhatsAppPhone("+91 72405 16000"), "+917240516000");
  assert.equal(normalizeWhatsAppPhone("917240516000"), "+917240516000");
});
