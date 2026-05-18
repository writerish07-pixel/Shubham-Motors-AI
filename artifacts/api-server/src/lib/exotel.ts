import axios from "axios";
import { logger } from "./logger";

const EXOTEL_SID = process.env.EXOTEL_SID;
const EXOTEL_API_KEY = process.env.EXOTEL_API_KEY;
const EXOTEL_API_TOKEN = process.env.EXOTEL_API_TOKEN;
const EXOTEL_VIRTUAL_NUMBER = process.env.EXOTEL_VIRTUAL_NUMBER;

const EXOTEL_BASE = `https://api.exotel.com/v1/Accounts/${EXOTEL_SID}`;

export async function makeOutboundCall(toNumber: string, callbackUrl: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      From: EXOTEL_VIRTUAL_NUMBER ?? "",
      To: toNumber,
      CallerId: EXOTEL_VIRTUAL_NUMBER ?? "",
      Url: callbackUrl,
      StatusCallback: `${callbackUrl.replace("/connect", "/status")}`,
      Record: "true",
    });

    const response = await axios.post(
      `${EXOTEL_BASE}/Calls/connect.json`,
      params.toString(),
      {
        auth: {
          username: EXOTEL_API_KEY ?? "",
          password: EXOTEL_API_TOKEN ?? "",
        },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      }
    );

    const callSid = response.data?.Call?.Sid;
    logger.info({ toNumber, callSid }, "Outbound call initiated");
    return callSid ?? null;
  } catch (err) {
    logger.error({ err, toNumber }, "Failed to initiate outbound call");
    return null;
  }
}

export async function transferCallToAgent(callSid: string, agentNumber: string): Promise<boolean> {
  try {
    const params = new URLSearchParams({
      Url: `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${agentNumber}</Dial></Response>`,
    });

    await axios.post(
      `${EXOTEL_BASE}/Calls/${callSid}.json`,
      params.toString(),
      {
        auth: {
          username: EXOTEL_API_KEY ?? "",
          password: EXOTEL_API_TOKEN ?? "",
        },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      }
    );
    logger.info({ callSid, agentNumber }, "Call transferred to agent");
    return true;
  } catch (err) {
    logger.error({ err, callSid }, "Failed to transfer call");
    return false;
  }
}
