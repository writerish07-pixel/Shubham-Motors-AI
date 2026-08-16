import axios from "axios";
import { logger } from "./logger";
import { withRetry } from "./resilience";
import { whatsappTemplatesOnly } from "./agentTools";

/** Official BotSpace Public API (Channel settings ID, not Meta Cloud phone_number_id). */
export const BOTSPACE_PUBLIC_API = "https://public-api.bot.space";

export function botspaceCreds(): { apiKey: string; channelId: string } {
  return {
    apiKey: process.env.BOTSPACE_API_KEY ?? "",
    channelId: process.env.BOTSPACE_PHONE_NUMBER_ID ?? process.env.BOTSPACE_CHANNEL_ID ?? "",
  };
}

export function botspaceConfigured(): boolean {
  const { apiKey, channelId } = botspaceCreds();
  return Boolean(apiKey && channelId);
}

export function normalizeWhatsAppPhone(phone: string): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

export function botspaceTemplateUrl(channelId: string): string {
  return `${BOTSPACE_PUBLIC_API}/v1/${channelId}/message/send-message`;
}

export function botspaceSessionUrl(channelId: string): string {
  return `${BOTSPACE_PUBLIC_API}/v1/${channelId}/message/send-session-message`;
}

export function botspaceMediaUrl(channelId: string): string {
  return `${BOTSPACE_PUBLIC_API}/v1/${channelId}/message/send-session-media-message`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export async function sendWhatsAppTemplate(
  phone: string,
  templateName: string,
  bodyParams: string[],
  languageCode = "hi",
  leadName = "",
): Promise<boolean> {
  const normalizedPhone = normalizeWhatsAppPhone(phone);
  const { apiKey, channelId } = botspaceCreds();
  if (!apiKey || !channelId || !templateName) return false;
  try {
    const response = await withRetry(
      () =>
        axios.post(
          botspaceTemplateUrl(channelId),
          {
            phone: normalizedPhone,
            name: leadName || undefined,
            templateId: templateName,
            templateLanguage: languageCode,
            variables: bodyParams.slice(0, 8).map((text) => String(text).slice(0, 500)),
          },
          { headers: authHeaders(apiKey), timeout: 25000 },
        ),
      { label: "whatsapp.sendTemplate" },
    );
    logger.info({ phone: normalizedPhone, templateName, status: response.status }, "WhatsApp template sent");
    return true;
  } catch (err) {
    logger.error({ err, phone, templateName }, "Failed to send WhatsApp template");
    return false;
  }
}

export async function sendWhatsAppMessage(phone: string, message: string, leadName = ""): Promise<boolean> {
  const normalizedPhone = normalizeWhatsAppPhone(phone);
  const { apiKey, channelId } = botspaceCreds();
  if (!apiKey || !channelId) {
    logger.warn({ hasKey: Boolean(apiKey), hasChannel: Boolean(channelId) }, "WhatsApp skipped — BotSpace key or channel ID missing");
    return false;
  }
  if (whatsappTemplatesOnly()) {
    const name = process.env.WHATSAPP_TEMPLATE_FOLLOWUP ?? "";
    if (!name) {
      logger.warn({ phone: normalizedPhone }, "WHATSAPP_TEMPLATES_ONLY set but WHATSAPP_TEMPLATE_FOLLOWUP missing — skip freeform");
      return false;
    }
    return sendWhatsAppTemplate(normalizedPhone, name, [message.slice(0, 500)], "hi", leadName);
  }
  try {
    const response = await withRetry(
      () =>
        axios.post(
          botspaceSessionUrl(channelId),
          {
            phone: normalizedPhone,
            name: leadName || undefined,
            text: message,
          },
          { headers: authHeaders(apiKey), timeout: 25000 },
        ),
      { label: "whatsapp.sendMessage" },
    );

    logger.info({ phone: normalizedPhone, status: response.status }, "WhatsApp message sent");
    return true;
  } catch (err) {
    logger.error({ err, phone }, "Failed to send WhatsApp session message");
    return false;
  }
}

/**
 * Send call summary to customer via WhatsApp.
 *
 * Hindi for hi / hi-IN sessions; English otherwise.
 */
export async function sendCallSummaryWhatsApp(
  phone: string,
  leadName: string,
  summary: string,
  interestedModel: string | null | undefined,
  language = "hi-IN",
  priceLine: string | null = null,
): Promise<boolean> {
  const isHindi = language.startsWith("hi");
  const nameStr = leadName?.trim() || "";
  const priceBlock = priceLine ? `\n\n${priceLine}` : "";

  let message: string;

  if (isHindi) {
    const modelLine = interestedModel ? `\n🏍️ *आपकी पसंद:* ${interestedModel}` : "";
    const addrName = nameStr ? `${nameStr} जी` : "आप";
    message =
      `नमस्ते ${addrName}! 🙏\n\n` +
      `*शुभम मोटर्स* (Hero MotoCorp) से बात करने के लिए धन्यवाद।\n\n` +
      `📋 *बातचीत का सारांश:*\n${summary}${modelLine}${priceBlock}\n\n` +
      `📍 Test ride के लिए हमारे showroom पर पधारें!\n\n` +
      `कोई भी जानकारी चाहिए तो call करें। आपकी सेवा में हमेशा तत्पर हैं! 🏆`;
  } else {
    const modelLine = interestedModel ? `\n🏍️ Model of Interest: *${interestedModel}*` : "";
    const addrName = nameStr || "there";
    message =
      `Hello ${addrName}! 👋\n\n` +
      `Thank you for speaking with us at *Shubham Motors* (Hero MotoCorp).\n\n` +
      `📋 *Call Summary:*\n${summary}${modelLine}${priceBlock}\n\n` +
      `📍 Visit us at our showroom for a test ride!\n\n` +
      `For any queries, feel free to call us back. We're here to help you find your perfect Hero bike! 🏆`;
  }

  return sendWhatsAppMessage(phone, message, nameStr);
}

export async function sendBrochureWhatsApp(
  phone: string,
  leadName: string,
  modelName: string,
  brochureUrl: string,
  language = "hi-IN",
): Promise<boolean> {
  try {
    const normalizedPhone = normalizeWhatsAppPhone(phone);
    const isHindi = language.startsWith("hi");
    const nameStr = leadName?.trim() || "";
    const { apiKey, channelId } = botspaceCreds();
    if (!apiKey || !channelId) return false;

    const caption = isHindi
      ? `नमस्ते ${nameStr ? nameStr + " जी" : ""}! Hero *${modelName}* की पूरी जानकारी भेज रही हूँ। Test ride के लिए शुभम मोटर्स में पधारें! 🏍️`
      : `Hi ${nameStr || "there"}! Here's the brochure for the *Hero ${modelName}* as discussed. Visit Shubham Motors for a test ride! 🏍️`;

    if (whatsappTemplatesOnly()) {
      const tpl = process.env.WHATSAPP_TEMPLATE_BROCHURE ?? process.env.WHATSAPP_TEMPLATE_FOLLOWUP ?? "";
      if (!tpl) {
        logger.warn({ phone: normalizedPhone }, "templates-only: no brochure template — skip");
        return false;
      }
      return sendWhatsAppTemplate(normalizedPhone, tpl, [nameStr || "ji", modelName], "hi", nameStr);
    }

    await withRetry(
      () =>
        axios.post(
          botspaceMediaUrl(channelId),
          {
            phone: normalizedPhone,
            name: nameStr || undefined,
            mediaUrl: brochureUrl,
            mediaType: "document",
            label: caption,
          },
          { headers: authHeaders(apiKey), timeout: 25000 },
        ),
      { label: "whatsapp.sendBrochure" },
    );

    return true;
  } catch (err) {
    logger.error({ err, phone }, "Failed to send brochure WhatsApp");
    return false;
  }
}
