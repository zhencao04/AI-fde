export type UserRole = "admin" | "user";

export type User = Readonly<{
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: number;
  updatedAt: number;
}>;

export type DecodedTokenWithOrg = DecodedToken & {
  organizationId?: string;
};

export type RegisterRequest = {
  email: string;
  username: string;
  password: string;
};

export type LoginRequest = {
  email: string;
  password: string;
};

export type LoginResponse = {
  accessToken: string;
  refreshToken: string;
  user: Omit<User, "passwordHash">;
};

export type RefreshRequest = {
  refreshToken: string;
};

export type ResetPasswordRequest = {
  email: string;
  oldPassword: string;
  newPassword: string;
};

export type DecodedToken = {
  userId: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
};