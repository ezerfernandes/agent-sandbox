import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "http";
import { verifyKey, touchKey, type ResolvedKey, type Scope } from "./key-store.js";
import { checkRateLimit } from "./rate-limiter.js";
import { authRequestsTotal, authRateLimitHits } from "../metrics.js";

declare global {
  namespace Express {
    interface Request {
      apiKey?: ResolvedKey;
    }
  }
}

/**
 * Outcome of authenticating a raw HTTP request. `key` is null when
 * AUTH_ENABLED=false, where every caller is let through unauthenticated.
 */
export type AuthResult =
  | { ok: true; key: ResolvedKey | null }
  | { ok: false; status: number; error: string; retryAfter?: number };

export function extractKey(req: Request | IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    const key = auth.slice(7).trim();
    return key.length > 0 ? key : null;
  }

  return null;
}

/**
 * Authenticate a bare `IncomingMessage`, so both Express routes and the
 * WebSocket upgrade handler (which has no Response to write to) share one
 * implementation. Bearer header only: `?access_token=` is never read, because
 * query strings leak into logs and proxies and the only WS caller is a
 * server-side proxy that can set headers.
 */
export function authenticateRequest(
  req: Request | IncomingMessage,
  requiredScopes: Scope[],
): AuthResult {
  if (process.env.AUTH_ENABLED === "false") {
    return { ok: true, key: null };
  }

  const rawKey = extractKey(req);
  if (!rawKey) {
    authRequestsTotal.inc({ result: "missing_key" });
    return { ok: false, status: 401, error: "API key required" };
  }

  const resolved: ResolvedKey | null = verifyKey(rawKey);
  if (!resolved) {
    authRequestsTotal.inc({ result: "invalid_key" });
    return { ok: false, status: 401, error: "Invalid API key" };
  }

  for (const scope of requiredScopes) {
    if (!resolved.scopes.includes(scope)) {
      authRequestsTotal.inc({ result: "forbidden" });
      return { ok: false, status: 403, error: `Missing required scope: ${scope}` };
    }
  }

  if (!checkRateLimit(resolved.id, resolved.rateLimit)) {
    authRequestsTotal.inc({ result: "rate_limited" });
    authRateLimitHits.inc({ key_id: resolved.id });
    return {
      ok: false,
      status: 429,
      error: "Rate limit exceeded",
      retryAfter: 60,
    };
  }

  touchKey(resolved.id);
  authRequestsTotal.inc({ result: "success" });
  return { ok: true, key: resolved };
}

export function authMiddleware(...requiredScopes: Scope[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = authenticateRequest(req, requiredScopes);

    if (!result.ok) {
      const body: { error: string; retryAfter?: number } = { error: result.error };
      if (result.retryAfter !== undefined) body.retryAfter = result.retryAfter;
      res.status(result.status).json(body);
      return;
    }

    if (result.key) {
      req.apiKey = result.key;
    }
    next();
  };
}
