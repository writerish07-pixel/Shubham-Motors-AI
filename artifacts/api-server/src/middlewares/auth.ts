import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

function readToken(req: Request): string {
  return (
    String(req.headers["x-admin-token"] ?? "").trim() ||
    String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim()
  );
}

/**
 * Constant-time token comparison — avoids leaking the admin token a byte at a
 * time via response-timing differences. Length is compared first (lengths are
 * not secret), then a fixed-time byte comparison.
 */
function tokenMatches(provided: string, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Protect CRM / scheduler / campaign APIs. Requires ADMIN_TOKEN env. */
export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "ADMIN_TOKEN not configured on server" });
    return;
  }
  if (!tokenMatches(readToken(req), expected)) {
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
  if (!tokenMatches(readToken(req), expected)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

/** Paths under /api that stay public (Exotel + health probe). */
export function isPublicApiPath(path: string): boolean {
  return path === "/healthz" || path === "/regress" || path.startsWith("/webhooks/");
}
