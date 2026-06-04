import axios from "axios";
import { logger } from "./logger";

const BOTSPACE_API_KEY = process.env.BOTSPACE_API_KEY;
const BOTSPACE_PHONE_ID = process.env.BOTSPACE_PHONE_NUMBER_ID;
const BOTSPACE_BASE = "https://api.botspace.io/api";

export async function sendWhatsAppMessage(phone: string, message: string): Promise<boolean> {
  try {
    const normalizedPhone = normalizePhone(phone);

    const response = await axios.post(
      `${BOTSPACE_BASE}/v1/${BOTSPACE_PHONE_ID}/messages`,
      {
        to: normalizedPhone,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${BOTSPACE_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 25000,
      }
    );

    logger.info({ phone: normalizedPhone, status: response.status }, "WhatsApp message sent");
    return true;
  } catch (err) {
    logger.error({ err, phone }, "Failed to send WhatsApp message");
    return false;
  }
}

/**
 * Send call summary to customer via WhatsApp.
 *
 * FIX: Previously always sent an English template regardless of the session language.
 * Now sends a Hindi message for Hindi-speaking customers (hi / hi-IN),
 * and falls back to English for English sessions.
 * Language should be the session.language value from callStream.ts.
 */
export async function sendCallSummaryWhatsApp(
  phone: string,
  leadName: string,
  summary: string,
  interestedModel: string | null | undefined,
  language = "hi-IN",
): Promise<boolean> {
  const isHindi = language.startsWith("hi");
  const nameStr = leadName?.trim() || "";

  let message: string;

  if (isHindi) {
    // Hindi message — matches the language the customer spoke in
    const modelLine = interestedModel ? `\n🏍️ *आपकी पसंद:* ${interestedModel}` : "";
    const addrName = nameStr ? `${nameStr} जी` : "आप";
    message =
      `नमस्ते ${addrName}! 🙏\n\n` +
      `*शुभम मोटर्स* (Hero MotoCorp) से बात करने के लिए धन्यवाद।\n\n` +
      `📋 *बातचीत का सारांश:*\n${summary}${modelLine}\n\n` +
      `📍 Test ride के लिए हमारे showroom पर पधारें!\n\n` +
      `कोई भी जानकारी चाहिए तो call करें। आपकी सेवा में हमेशा तत्पर हैं! 🏆`;
  } else {
    // English message
    const modelLine = interestedModel ? `\n🏍️ Model of Interest: *${interestedModel}*` : "";
    const addrName = nameStr || "there";
    message =
      `Hello ${addrName}! 👋\n\n` +
      `Thank you for speaking with us at *Shubham Motors* (Hero MotoCorp).\n\n` +
      `📋 *Call Summary:*\n${summary}${modelLine}\n\n` +
      `📍 Visit us at our showroom for a test ride!\n\n` +
      `For any queries, feel free to call us back. We're here to help you find your perfect Hero bike! 🏆`;
  }

  return sendWhatsAppMessage(phone, message);
}

export async function sendBrochureWhatsApp(
  phone: string,
  leadName: string,
  modelName: string,
  brochureUrl: string,
  language = "hi-IN",
): Promise<boolean> {
  try {
    const normalizedPhone = normalizePhone(phone);
    const isHindi = language.startsWith("hi");
    const nameStr = leadName?.trim() || "";

    const caption = isHindi
      ? `नमस्ते ${nameStr ? nameStr + " जी" : ""}! Hero *${modelName}* की पूरी जानकारी भेज रही हूँ। Test ride के लिए शुभम मोटर्स में पधारें! 🏍️`
      : `Hi ${nameStr || "there"}! Here's the brochure for the *Hero ${modelName}* as discussed. Visit Shubham Motors for a test ride! 🏍️`;

    await axios.post(
      `${BOTSPACE_BASE}/v1/${BOTSPACE_PHONE_ID}/messages`,
      {
        to: normalizedPhone,
        type: "document",
        document: {
          link: brochureUrl,
          caption,
          filename: `Hero_${modelName}_Brochure.pdf`,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${BOTSPACE_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 25000,
      }
    );

    return true;
  } catch (err) {
    logger.error({ err, phone }, "Failed to send brochure WhatsApp");
    return false;
  }
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return digits;
  if (digits.length === 10) return `91${digits}`;
  return digits;
}
