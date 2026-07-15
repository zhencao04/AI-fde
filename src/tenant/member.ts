import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Member, AddMemberRequest, UpdateMemberRequest, OrgRole } from "./types";

const DATA_ROOT = join(process.cwd(), ".data");
const MEMBERS_FILE = join(DATA_ROOT, "members.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_ROOT)) {
    mkdirSync(DATA_ROOT, { recursive: true, mode: 0o700 });
  }
}

function loadMembers(): Member[] {
  ensureDataDir();
  if (!existsSync(MEMBERS_FILE)) {
    writeFileSync(MEMBERS_FILE, JSON.stringify([], null, 2), { mode: 0o600 });
    return [];
  }
  try {
    const raw = readFileSync(MEMBERS_FILE, "utf8");
    return JSON.parse(raw) as Member[];
  } catch {
    return [];
  }
}

function saveMembers(members: Member[]): void {
  ensureDataDir();
  writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2), { mode: 0o600 });
}

export function addMember(organizationId: string, req: AddMemberRequest): Member {
  if (!req.userId) {
    throw new Error("USER_ID_REQUIRED");
  }

  const members = loadMembers();
  const existing = members.find(m => m.organizationId === organizationId && m.userId === req.userId);
  if (existing) {
    throw new Error("MEMBER_ALREADY_EXISTS");
  }

  const now = Date.now();
  const member: Member = {
    organizationId,
    userId: req.userId,
    role: req.role || "member",
    joinedAt: now,
  };

  members.push(member);
  saveMembers(members);
  return member;
}

export function listMembers(organizationId: string): Member[] {
  const members = loadMembers();
  return members.filter(m => m.organizationId === organizationId);
}

export function findMember(organizationId: string, userId: string): Member | null {
  const members = loadMembers();
  return members.find(m => m.organizationId === organizationId && m.userId === userId) || null;
}

export function updateMemberRole(organizationId: string, userId: string, req: UpdateMemberRequest): Member | null {
  const members = loadMembers();
  const index = members.findIndex(m => m.organizationId === organizationId && m.userId === userId);
  if (index === -1) {
    return null;
  }

  members[index] = {
    ...members[index],
    role: req.role,
  };

  saveMembers(members);
  return members[index];
}

export function removeMember(organizationId: string, userId: string): boolean {
  const members = loadMembers();
  const index = members.findIndex(m => m.organizationId === organizationId && m.userId === userId);
  if (index === -1) {
    return false;
  }

  members.splice(index, 1);
  saveMembers(members);
  return true;
}

export function getOrganizationsByUserId(userId: string): string[] {
  const members = loadMembers();
  return [...new Set(members.filter(m => m.userId === userId).map(m => m.organizationId))];
}

export function getUserRoleInOrganization(userId: string, organizationId: string): OrgRole | null {
  const members = loadMembers();
  const member = members.find(m => m.userId === userId && m.organizationId === organizationId);
  return member?.role || null;
}