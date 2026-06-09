import type { Request, Response, NextFunction } from "express";

function readToken(req: Request): string {
  return (
    String(req.headers["x-admin-token"] ?? "").trim() ||
    String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim()
  );
}

/** Protect CRM / scheduler / campaign APIs. Requires ADMIN_TOKEN env. */
export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "ADMIN_TOKEN not configured on server" });
    return;
  }
  if (readToken(req) !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

/** Same guard for route-level use (KB uploads, contacts). */
export function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "ADMIN_TOKEN not configured on server" });
    return false;
  }
  if (readToken(req) !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

/** Paths under /api that stay public (Exotel + health probe). */
export function isPublicApiPath(path: string): boolean {
  return path === "/healthz" || path.startsWith("/webhooks/");
}
