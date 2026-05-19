import axios from "axios";
import { logger } from "./logger";

// Read at call time so any secret update + restart picks up fresh values
function creds() {
  return {
    sid: process.env.EXOTEL_SID ?? "",
    apiKey: process.env.EXOTEL_API_KEY ?? "",
    apiToken: process.env.EXOTEL_API_TOKEN ?? "",
    virtualNumber: process.env.EXOTEL_VIRTUAL_NUMBER ?? "",
    base: `https://api.exotel.com/v1/Accounts/${process.env.EXOTEL_SID}`,
  };
}

/**
 * Place an outbound call via Exotel Connect API.
 *
 * Exotel parameter meanings:
 *   From       = ExoPhone (your virtual landline shown as caller ID)
 *   To         = Customer's phone number (who you want to call)
 *   CallerId   = ExoPhone (caller ID shown to customer)
 *   Url        = Webhook URL that returns ExoML when the call connects
 *   StatusCallback = Webhook URL called when call status changes
 */
export async function makeOutboundCall(
  toNumber: string,
  webhookBaseUrl: string
): Promise<string | null> {
  const { sid, apiKey, apiToken, virtualNumber, base } = creds();

  // Normalise to 10-digit mobile number (no leading 0 for mobile)
  const digits = toNumber.replace(/\D/g, "").slice(-10);
  const inboundUrl = `${webhookBaseUrl}/api/webhooks/exotel/inbound`;
  const statusUrl = `${webhookBaseUrl}/api/webhooks/exotel/status`;

  logger.info({ sid, From: virtualNumber, To: digits, inboundUrl }, "Placing outbound call");

  const params = new URLSearchParams({
    From: virtualNumber,
    To: digits,
    CallerId: virtualNumber,
    Url: inboundUrl,
    StatusCallback: statusUrl,
    Record: "true",
  });

  try {
    const response = await axios.post(
      `${base}/Calls/connect.json`,
      params.toString(),
      {
        auth: { username: apiKey, password: apiToken },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      }
    );
    const call = response.data?.Call;
    logger.info({ callSid: call?.Sid, status: call?.Status, to: digits }, "Outbound call placed");
    return call?.Sid ?? null;
  } catch (err: unknown) {
    const ae = err as { response?: { status?: number; data?: unknown } };
    logger.error(
      { httpStatus: ae.response?.status, body: ae.response?.data, to: digits },
      "Outbound call API error"
    );
    return null;
  }
}

export async function transferCallToAgent(callSid: string, agentNumber: string): Promise<boolean> {
  const { apiKey, apiToken, base } = creds();
  try {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${agentNumber}</Dial></Response>`;
    await axios.post(
      `${base}/Calls/${callSid}.json`,
      new URLSearchParams({ Url: xml }).toString(),
      {
        auth: { username: apiKey, password: apiToken },
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
