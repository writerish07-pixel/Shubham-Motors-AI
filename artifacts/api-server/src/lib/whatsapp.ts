import axios from "axios";
import { logger } from "./logger";

const BOTSPACE_API_KEY = process.env.BOTSPACE_API_KEY;
const BOTSPACE_PHONE_ID = process.env.BOTSPACE_PHONE_NUMBER_ID;
const BOTSPACE_BASE = "https://api.botspace.app/api";

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
        timeout: 10000,
      }
    );

    logger.info({ phone: normalizedPhone, status: response.status }, "WhatsApp message sent");
    return true;
  } catch (err) {
    logger.error({ err, phone }, "Failed to send WhatsApp message");
    return false;
  }
}

export async function sendCallSummaryWhatsApp(
  phone: string,
  leadName: string,
  summary: string,
  interestedModel: string | null | undefined
): Promise<boolean> {
  const modelLine = interestedModel ? `\n🏍️ Model of Interest: *${interestedModel}*` : "";
  const message = `Hello ${leadName}! 👋\n\nThank you for speaking with us at *Shubham Motors* (Hero MotoCorp).\n\n📋 *Call Summary:*\n${summary}${modelLine}\n\n📍 Visit us at our showroom for a test ride!\n\nFor any queries, feel free to call us back. We're here to help you find your perfect Hero bike! 🏆`;

  return sendWhatsAppMessage(phone, message);
}

export async function sendBrochureWhatsApp(
  phone: string,
  leadName: string,
  modelName: string,
  brochureUrl: string
): Promise<boolean> {
  try {
    const normalizedPhone = normalizePhone(phone);

    await axios.post(
      `${BOTSPACE_BASE}/v1/${BOTSPACE_PHONE_ID}/messages`,
      {
        to: normalizedPhone,
        type: "document",
        document: {
          link: brochureUrl,
          caption: `Hi ${leadName}! Here's the brochure for the *Hero ${modelName}* as discussed. Visit Shubham Motors for a test ride! 🏍️`,
          filename: `Hero_${modelName}_Brochure.pdf`,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${BOTSPACE_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
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
