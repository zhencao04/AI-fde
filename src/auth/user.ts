import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import type { User, RegisterRequest, ResetPasswordRequest, UserRole } from "./types";

const DATA_ROOT = join(process.cwd(), ".data");
const USERS_FILE = join(DATA_ROOT, "users.json");
const SALT_ROUNDS = 12;

function ensureDataDir(): void {
  if (!existsSync(DATA_ROOT)) {
    mkdirSync(DATA_ROOT, { recursive: true, mode: 0o700 });
  }
}

export function loadUsers(): User[] {
  ensureDataDir();
  if (!existsSync(USERS_FILE)) {
    const adminUser: User = {
      id: "admin_" + randomBytes(16).toString("hex"),
      email: "admin@example.com",
      username: "admin",
      passwordHash: bcrypt.hashSync("admin123", SALT_ROUNDS),
      role: "admin",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeFileSync(USERS_FILE, JSON.stringify([adminUser], null, 2), { mode: 0o600 });
    return [adminUser];
  }
  try {
    const raw = readFileSync(USERS_FILE, "utf8");
    return JSON.parse(raw) as User[];
  } catch {
    return [];
  }
}

export function saveUsers(users: User[]): void {
  ensureDataDir();
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

export function registerUser(req: RegisterRequest): User {
  if (!req.email || !req.email.includes("@")) {
    throw new Error("INVALID_EMAIL");
  }
  if (!req.username || req.username.length < 2) {
    throw new Error("USERNAME_TOO_SHORT");
  }
  if (!req.password || req.password.length < 8) {
    throw new Error("PASSWORD_TOO_SHORT");
  }

  const users = loadUsers();
  const existing = users.find(u => u.email === req.email || u.username === req.username);
  if (existing) {
    throw new Error("USER_EXISTS");
  }

  const passwordHash = bcrypt.hashSync(req.password, SALT_ROUNDS);
  const now = Date.now();
  const user: User = {
    id: "user_" + randomBytes(16).toString("hex"),
    email: req.email,
    username: req.username,
    passwordHash,
    role: "user",
    createdAt: now,
    updatedAt: now,
  };

  users.push(user);
  saveUsers(users);
  return user;
}

export function findUserByEmail(email: string): User | null {
  const users = loadUsers();
  return users.find(u => u.email === email) || null;
}

export function findUserById(id: string): User | null {
  const users = loadUsers();
  return users.find(u => u.id === id) || null;
}

export function validatePassword(user: User, password: string): boolean {
  return bcrypt.compareSync(password, user.passwordHash);
}

export function resetPassword(req: ResetPasswordRequest): User {
  const user = findUserByEmail(req.email);
  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }
  if (!validatePassword(user, req.oldPassword)) {
    throw new Error("INVALID_PASSWORD");
  }
  if (!req.newPassword || req.newPassword.length < 8) {
    throw new Error("PASSWORD_TOO_SHORT");
  }

  const users = loadUsers();
  const index = users.findIndex(u => u.id === user.id);
  if (index === -1) {
    throw new Error("USER_NOT_FOUND");
  }

  const passwordHash = bcrypt.hashSync(req.newPassword, SALT_ROUNDS);
  users[index] = {
    ...users[index],
    passwordHash,
    updatedAt: Date.now(),
  };

  saveUsers(users);
  return users[index];
}

export function updateUserRole(userId: string, role: UserRole): User | null {
  const users = loadUsers();
  const index = users.findIndex(u => u.id === userId);
  if (index === -1) {
    return null;
  }

  users[index] = {
    ...users[index],
    role,
    updatedAt: Date.now(),
  };

  saveUsers(users);
  return users[index];
}