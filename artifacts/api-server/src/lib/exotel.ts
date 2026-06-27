import axios from "axios";
import { logger } from "./logger";
import { getPublicBaseUrl } from "./publicUrl";
import { withRetry } from "./resilience";

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
    const response = await withRetry(
      () =>
        axios.post(
          `${base}/Calls/connect.json`,
          params.toString(),
          {
            auth: { username: apiKey, password: apiToken },
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 15000,
          }
        ),
      { label: "exotel.makeOutboundCall", retries: 2 },
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
  const pub = getPublicBaseUrl();
  if (!pub) {
    logger.error({ callSid }, "Cannot transfer — REPLIT_DOMAINS / PUBLIC_BASE_URL not set");
    return false;
  }
  const xmlUrl = `${pub}/api/webhooks/exotel/dial-agent.xml?to=${encodeURIComponent(agentNumber)}`;
  try {
    await withRetry(
      () =>
        axios.post(
          `${base}/Calls/${callSid}.json`,
          new URLSearchParams({ Url: xmlUrl }).toString(),
          {
            auth: { username: apiKey, password: apiToken },
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 10000,
          }
        ),
      // Mid-call: keep retries quick so the customer is not left on hold.
      { label: "exotel.transferCall", retries: 2, baseDelayMs: 200, maxDelayMs: 800 },
    );
    logger.info({ callSid, agentNumber, xmlUrl }, "Call transferred to agent");
    return true;
  } catch (err: unknown) {
    const ae = err as { response?: { status?: number; data?: unknown } };
    logger.error({ httpStatus: ae.response?.status, body: ae.response?.data, callSid }, "Failed to transfer call");
    return false;
  }
}
