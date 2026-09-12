import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "http";
import { extractKey, authMiddleware, authenticateRequest } from "./middleware.js";
import * as keyStore from "./key-store.js";

vi.mock("./key-store.js");
vi.mock("./rate-limiter.js", () => ({
  checkRateLimit: vi.fn(() => true),
}));

import { checkRateLimit } from "./rate-limiter.js";

describe("auth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockReturnValue(true);
    delete process.env.AUTH_ENABLED;
  });

  describe("extractKey", () => {
    it("extracts key from Authorization Bearer header", () => {
      const req = {
        headers: { authorization: "Bearer sk_test_secret123" },
        query: {},
      } as unknown as Request;
      expect(extractKey(req)).toBe("sk_test_secret123");
    });

    it("rejects x-api-key header (standardizes on Bearer token)", () => {
      const req = {
        headers: { "x-api-key": "sk_test_header123" },
        query: {},
      } as unknown as Request;
      expect(extractKey(req)).toBeNull();
    });

    it("rejects empty Bearer token", () => {
      const req = {
        headers: { authorization: "Bearer " },
        query: {},
      } as unknown as Request;
      expect(extractKey(req)).toBeNull();
    });

    it("rejects non-Bearer authorization schemes", () => {
      const req = {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
        query: {},
      } as unknown as Request;
      expect(extractKey(req)).toBeNull();
    });

    it("rejects/ignores query parameter API keys (OWASP compliance)", () => {
      const req = {
        headers: {},
        query: { api_key: "sk_test_query123", apiKey: "sk_test_query456" },
      } as unknown as Request;
      expect(extractKey(req)).toBeNull();
    });
  });

  describe("authMiddleware", () => {
    it("rejects requests missing an API key header with 401", () => {
      const req = { headers: {}, query: {} } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn();

      authMiddleware("exec")(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "API key required" });
      expect(next).not.toHaveBeenCalled();
    });

    it("allows valid requests with matching scope", () => {
      vi.mocked(keyStore.verifyKey).mockReturnValue({
        id: "key-1",
        name: "Test Key",
        scopes: ["exec", "admin"],
        rateLimit: 100,
      });

      const req = {
        headers: { authorization: "Bearer sk_test_valid" },
        query: {},
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn();

      authMiddleware("exec")(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.apiKey).toBeDefined();
      expect(req.apiKey?.id).toBe("key-1");
    });

    it("rejects requests with missing required scope with 403", () => {
      vi.mocked(keyStore.verifyKey).mockReturnValue({
        id: "key-2",
        name: "Exec Only",
        scopes: ["exec"],
        rateLimit: 100,
      });

      const req = {
        headers: { authorization: "Bearer sk_test_exec" },
        query: {},
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn();

      authMiddleware("admin")(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "Missing required scope: admin",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("does not recognize legacy MCP_AUTH_TOKEN (rejects with 401)", () => {
      process.env.MCP_AUTH_TOKEN = "legacy-token-secret";
      vi.mocked(keyStore.verifyKey).mockReturnValue(null);
      const req = {
        headers: { authorization: "Bearer legacy-token-secret" },
        query: {},
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn();

      authMiddleware("exec")(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid API key" });
      expect(next).not.toHaveBeenCalled();
      delete process.env.MCP_AUTH_TOKEN;
    });
  });
  describe("authenticateRequest", () => {
    it("returns the resolved key for a valid Bearer token with the required scopes", () => {
      vi.mocked(keyStore.verifyKey).mockReturnValue({
        id: "key-1",
        name: "Test Key",
        scopes: ["exec", "admin"],
        rateLimit: 100,
      });

      const req = {
        headers: { authorization: "Bearer sk_test_valid" },
      } as unknown as IncomingMessage;

      const result = authenticateRequest(req, ["exec"]);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.key?.id).toBe("key-1");
      expect(keyStore.touchKey).toHaveBeenCalledWith("key-1");
    });

    it("returns 401 when no Bearer header is present", () => {
      const req = { headers: {} } as unknown as IncomingMessage;

      const result = authenticateRequest(req, ["exec"]);

      expect(result).toEqual({ ok: false, status: 401, error: "API key required" });
    });

    it("ignores ?access_token= query parameters (header-only Bearer)", () => {
      const req = {
        headers: {},
        url: "/exec/s1/vnc?access_token=sk_test_query",
      } as unknown as IncomingMessage;

      const result = authenticateRequest(req, ["exec"]);

      expect(result).toEqual({ ok: false, status: 401, error: "API key required" });
      expect(keyStore.verifyKey).not.toHaveBeenCalled();
    });

    it("returns 401 for an unknown key", () => {
      vi.mocked(keyStore.verifyKey).mockReturnValue(null);
      const req = {
        headers: { authorization: "Bearer sk_test_unknown" },
      } as unknown as IncomingMessage;

      const result = authenticateRequest(req, ["exec"]);

      expect(result).toEqual({ ok: false, status: 401, error: "Invalid API key" });
    });

    it("returns 403 when a required scope is missing", () => {
      vi.mocked(keyStore.verifyKey).mockReturnValue({
        id: "key-2",
        name: "Exec Only",
        scopes: ["exec"],
        rateLimit: 100,
      });
      const req = {
        headers: { authorization: "Bearer sk_test_exec" },
      } as unknown as IncomingMessage;

      const result = authenticateRequest(req, ["admin"]);

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: "Missing required scope: admin",
      });
    });

    it("returns 429 with retryAfter when the key is rate limited", () => {
      vi.mocked(keyStore.verifyKey).mockReturnValue({
        id: "key-3",
        name: "Busy Key",
        scopes: ["exec"],
        rateLimit: 1,
      });
      vi.mocked(checkRateLimit).mockReturnValue(false);

      const req = {
        headers: { authorization: "Bearer sk_test_busy" },
      } as unknown as IncomingMessage;

      const result = authenticateRequest(req, ["exec"]);

      expect(result).toEqual({
        ok: false,
        status: 429,
        error: "Rate limit exceeded",
        retryAfter: 60,
      });
    });

    it("short-circuits with a null key when AUTH_ENABLED=false", () => {
      process.env.AUTH_ENABLED = "false";
      const req = { headers: {} } as unknown as IncomingMessage;

      const result = authenticateRequest(req, ["exec"]);

      expect(result).toEqual({ ok: true, key: null });
      expect(keyStore.verifyKey).not.toHaveBeenCalled();
    });
  });
});
