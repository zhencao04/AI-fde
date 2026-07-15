"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const rate_limit_1 = require("@/middleware/rate-limit");
(0, vitest_1.describe)("rate-limit", () => {
    let mockReq;
    let mockRes;
    let mockNext;
    (0, vitest_1.beforeEach)(() => {
        mockReq = {
            ip: "127.0.0.1",
            path: "/api/test",
            headers: {},
        };
        mockRes = {
            setHeader: vitest_1.vi.fn(),
            status: vitest_1.vi.fn().mockReturnThis(),
            json: vitest_1.vi.fn(),
        };
        mockNext = vitest_1.vi.fn();
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.describe)("rateLimit", () => {
        (0, vitest_1.it)("should allow requests within limit", () => {
            const limiter = (0, rate_limit_1.rateLimit)({
                windowMs: 60 * 1000,
                maxRequests: 5,
            }, "test-allow");
            const localNext = vitest_1.vi.fn();
            for (let i = 0; i < 5; i++) {
                limiter(mockReq, mockRes, localNext);
            }
            (0, vitest_1.expect)(localNext).toHaveBeenCalledTimes(5);
        });
        (0, vitest_1.it)("should block requests exceeding limit", () => {
            const limiter = (0, rate_limit_1.rateLimit)({
                windowMs: 60 * 1000,
                maxRequests: 5,
            }, "test-block");
            const localNext = vitest_1.vi.fn();
            const localRes = {
                setHeader: vitest_1.vi.fn(),
                status: vitest_1.vi.fn().mockReturnThis(),
                json: vitest_1.vi.fn(),
            };
            for (let i = 0; i < 6; i++) {
                limiter(mockReq, localRes, localNext);
            }
            (0, vitest_1.expect)(localNext).toHaveBeenCalledTimes(5);
            (0, vitest_1.expect)(localRes.status).toHaveBeenCalledWith(429);
            (0, vitest_1.expect)(localRes.json).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                error: "TOO_MANY_REQUESTS",
            }));
        });
        (0, vitest_1.it)("should set rate limit headers", () => {
            const limiter = (0, rate_limit_1.rateLimit)({
                windowMs: 60 * 1000,
                maxRequests: 5,
            }, "test-headers");
            const localRes = {
                setHeader: vitest_1.vi.fn(),
                status: vitest_1.vi.fn().mockReturnThis(),
                json: vitest_1.vi.fn(),
            };
            limiter(mockReq, localRes, mockNext);
            (0, vitest_1.expect)(localRes.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", "5");
            (0, vitest_1.expect)(localRes.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", "4");
            (0, vitest_1.expect)(localRes.setHeader).toHaveBeenCalledWith("X-RateLimit-Window", "60000");
        });
        (0, vitest_1.it)("should use x-forwarded-for header when available", () => {
            const limiter = (0, rate_limit_1.rateLimit)({
                windowMs: 60 * 1000,
                maxRequests: 5,
            }, "test-xforwarded");
            const reqWithForward = {
                ip: "127.0.0.1",
                path: "/api/test",
                headers: { "x-forwarded-for": "192.168.1.100, 10.0.0.1" },
            };
            limiter(reqWithForward, mockRes, mockNext);
            (0, vitest_1.expect)(mockNext).toHaveBeenCalled();
        });
        (0, vitest_1.it)("should use socket remoteAddress when ip is not available", () => {
            const limiter = (0, rate_limit_1.rateLimit)({
                windowMs: 60 * 1000,
                maxRequests: 5,
            }, "test-socket");
            const reqWithSocket = {
                path: "/api/test",
                headers: {},
                socket: { remoteAddress: "192.168.1.200" },
            };
            limiter(reqWithSocket, mockRes, mockNext);
            (0, vitest_1.expect)(mockNext).toHaveBeenCalled();
        });
        (0, vitest_1.it)("should use 'unknown' when no ip is available", () => {
            const limiter = (0, rate_limit_1.rateLimit)({
                windowMs: 60 * 1000,
                maxRequests: 5,
            }, "test-unknown");
            const reqWithoutIp = {
                path: "/api/test",
                headers: {},
            };
            limiter(reqWithoutIp, mockRes, mockNext);
            (0, vitest_1.expect)(mockNext).toHaveBeenCalled();
        });
    });
    (0, vitest_1.describe)("authRateLimit", () => {
        (0, vitest_1.it)("should apply auth rate limit", () => {
            mockReq.path = "/api/auth/login";
            for (let i = 0; i < 6; i++) {
                (0, rate_limit_1.authRateLimit)(mockReq, mockRes, mockNext);
            }
            (0, vitest_1.expect)(mockNext).toHaveBeenCalledTimes(5);
            (0, vitest_1.expect)(mockRes.status).toHaveBeenCalledWith(429);
        });
    });
    (0, vitest_1.describe)("apiRateLimit", () => {
        (0, vitest_1.it)("should apply api rate limit", () => {
            mockReq.path = "/api/sessions";
            for (let i = 0; i < 121; i++) {
                (0, rate_limit_1.apiRateLimit)(mockReq, mockRes, mockNext);
            }
            (0, vitest_1.expect)(mockNext).toHaveBeenCalledTimes(120);
            (0, vitest_1.expect)(mockRes.status).toHaveBeenCalledWith(429);
        });
    });
    (0, vitest_1.describe)("uploadRateLimit", () => {
        (0, vitest_1.it)("should apply upload rate limit", () => {
            mockReq.path = "/api/upload";
            for (let i = 0; i < 31; i++) {
                (0, rate_limit_1.uploadRateLimit)(mockReq, mockRes, mockNext);
            }
            (0, vitest_1.expect)(mockNext).toHaveBeenCalledTimes(30);
            (0, vitest_1.expect)(mockRes.status).toHaveBeenCalledWith(429);
        });
    });
    (0, vitest_1.describe)("startRateLimitCleaner", () => {
        (0, vitest_1.it)("should start cleaner interval", () => {
            const intervalSpy = vitest_1.vi.spyOn(global, "setInterval");
            (0, rate_limit_1.startRateLimitCleaner)();
            (0, vitest_1.expect)(intervalSpy).toHaveBeenCalled();
            intervalSpy.mockRestore();
        });
    });
});
