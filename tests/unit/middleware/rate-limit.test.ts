import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rateLimit, authRateLimit, apiRateLimit, uploadRateLimit, startRateLimitCleaner } from "@/middleware/rate-limit";
import { Request, Response, NextFunction } from "express";

describe("rate-limit", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      ip: "127.0.0.1",
      path: "/api/test",
      headers: {},
    };

    mockRes = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    mockNext = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("rateLimit", () => {
    it("should allow requests within limit", () => {
      const limiter = rateLimit({
        windowMs: 60 * 1000,
        maxRequests: 5,
      }, "test-allow");

      const localNext = vi.fn();

      for (let i = 0; i < 5; i++) {
        limiter(mockReq as Request, mockRes as Response, localNext);
      }

      expect(localNext).toHaveBeenCalledTimes(5);
    });

    it("should block requests exceeding limit", () => {
      const limiter = rateLimit({
        windowMs: 60 * 1000,
        maxRequests: 5,
      }, "test-block");

      const localNext = vi.fn();
      const localRes: Partial<Response> = {
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      for (let i = 0; i < 6; i++) {
        limiter(mockReq as Request, localRes as Response, localNext);
      }

      expect(localNext).toHaveBeenCalledTimes(5);
      expect(localRes.status).toHaveBeenCalledWith(429);
      expect(localRes.json).toHaveBeenCalledWith(expect.objectContaining({
        error: "TOO_MANY_REQUESTS",
      }));
    });

    it("should set rate limit headers", () => {
      const limiter = rateLimit({
        windowMs: 60 * 1000,
        maxRequests: 5,
      }, "test-headers");

      const localRes: Partial<Response> = {
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      limiter(mockReq as Request, localRes as Response, mockNext);

      expect(localRes.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", "5");
      expect(localRes.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", "4");
      expect(localRes.setHeader).toHaveBeenCalledWith("X-RateLimit-Window", "60000");
    });

    it("should use x-forwarded-for header when available", () => {
      const limiter = rateLimit({
        windowMs: 60 * 1000,
        maxRequests: 5,
      }, "test-xforwarded");

      const reqWithForward: Partial<Request> = {
        ip: "127.0.0.1",
        path: "/api/test",
        headers: { "x-forwarded-for": "192.168.1.100, 10.0.0.1" },
      };

      limiter(reqWithForward as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should use socket remoteAddress when ip is not available", () => {
      const limiter = rateLimit({
        windowMs: 60 * 1000,
        maxRequests: 5,
      }, "test-socket");

      const reqWithSocket: Partial<Request> = {
        path: "/api/test",
        headers: {},
        socket: { remoteAddress: "192.168.1.200" },
      };

      limiter(reqWithSocket as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should use 'unknown' when no ip is available", () => {
      const limiter = rateLimit({
        windowMs: 60 * 1000,
        maxRequests: 5,
      }, "test-unknown");

      const reqWithoutIp: Partial<Request> = {
        path: "/api/test",
        headers: {},
      };

      limiter(reqWithoutIp as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe("authRateLimit", () => {
    it("should apply auth rate limit", () => {
      mockReq.path = "/api/auth/login";

      for (let i = 0; i < 6; i++) {
        authRateLimit(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockNext).toHaveBeenCalledTimes(5);
      expect(mockRes.status).toHaveBeenCalledWith(429);
    });
  });

  describe("apiRateLimit", () => {
    it("should apply api rate limit", () => {
      mockReq.path = "/api/sessions";

      for (let i = 0; i < 121; i++) {
        apiRateLimit(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockNext).toHaveBeenCalledTimes(120);
      expect(mockRes.status).toHaveBeenCalledWith(429);
    });
  });

  describe("uploadRateLimit", () => {
    it("should apply upload rate limit", () => {
      mockReq.path = "/api/upload";

      for (let i = 0; i < 31; i++) {
        uploadRateLimit(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockNext).toHaveBeenCalledTimes(30);
      expect(mockRes.status).toHaveBeenCalledWith(429);
    });
  });

  describe("startRateLimitCleaner", () => {
    it("should start cleaner interval", () => {
      const intervalSpy = vi.spyOn(global, "setInterval");

      startRateLimitCleaner();

      expect(intervalSpy).toHaveBeenCalled();
      intervalSpy.mockRestore();
    });
  });
});
