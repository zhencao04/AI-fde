import jwt from "jsonwebtoken";
import type { User, LoginResponse, DecodedTokenWithOrg } from "./types";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production-2024";
const ACCESS_TOKEN_EXPIRES_IN = "15m";
const REFRESH_TOKEN_EXPIRES_IN = "7d";

export function generateTokens(user: User, organizationId?: string): LoginResponse {
  const payload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    organizationId,
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });

  const refreshToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
  });

  const { passwordHash, ...userWithoutPassword } = user;

  return {
    accessToken,
    refreshToken,
    user: userWithoutPassword,
  };
}

export function verifyToken(token: string): DecodedTokenWithOrg | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as DecodedTokenWithOrg;
    return decoded;
  } catch {
    return null;
  }
}

export function refreshAccessToken(refreshToken: string): LoginResponse | null {
  const decoded = verifyToken(refreshToken);
  if (!decoded) {
    return null;
  }

  const payload = {
    userId: decoded.userId,
    email: decoded.email,
    role: decoded.role,
    organizationId: decoded.organizationId,
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: decoded.userId,
      email: decoded.email,
      username: "",
      role: decoded.role,
      createdAt: 0,
      updatedAt: 0,
    },
  };
}

export function extractTokenFromHeader(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/);
  return match ? match[1] : null;
}