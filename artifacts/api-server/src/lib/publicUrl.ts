/** Public HTTPS base URL for Exotel webhooks and transfer XML (no trailing slash). */
export function getPublicBaseUrl(): string {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  // Legacy Replit hostnames — do not set these on Fly/VPS.
  const domains = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (domains[0]) return `https://${domains[0]}`;
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return "";
}

/** Webhook base passed to makeOutboundCall (includes localhost fallback for dev). */
export function getWebhookBaseUrl(): string {
  return getPublicBaseUrl() || "http://localhost:5000";
}
