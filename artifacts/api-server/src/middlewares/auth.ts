import type { Request, Response, NextFunction } from "express";

// Public API paths that must NOT require the admin token. Mounted under "/api",
// so req.path here is relative to that mount point.
//   • /healthz       — health probe
//   • /webhooks/*    — Exotel / telephony callbacks (no token; trusted by path)
export function isPublicApiPath(path: string): boolean {
  return path === "/healthz" || path.startsWith("/webhooks/");
}

// Global guard for all /api/* routes. Accepts the admin token via either
// `X-Admin-Token: <token>` or `Authorization: Bearer <token>`.
// If ADMIN_TOKEN is unset we DENY by default so an empty env can't be exploited.
export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  if (isPublicApiPath(req.path)) { next(); return; }

  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "ADMIN_TOKEN not configured on server" });
    return;
  }

  const got =
    String(req.headers["x-admin-token"] ?? "").trim() ||
    String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();

  if (got && got === expected) { next(); return; }
  res.status(401).json({ error: "Unauthorized" });
}
