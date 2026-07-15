import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Organization, CreateOrganizationRequest, UpdateOrganizationRequest } from "./types";
import { DEFAULT_QUOTA } from "./types";

const DATA_ROOT = join(process.cwd(), ".data");
const ORGANIZATIONS_FILE = join(DATA_ROOT, "organizations.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_ROOT)) {
    mkdirSync(DATA_ROOT, { recursive: true, mode: 0o700 });
  }
}

function loadOrganizations(): Organization[] {
  ensureDataDir();
  if (!existsSync(ORGANIZATIONS_FILE)) {
    writeFileSync(ORGANIZATIONS_FILE, JSON.stringify([], null, 2), { mode: 0o600 });
    return [];
  }
  try {
    const raw = readFileSync(ORGANIZATIONS_FILE, "utf8");
    return JSON.parse(raw) as Organization[];
  } catch {
    return [];
  }
}

function saveOrganizations(organizations: Organization[]): void {
  ensureDataDir();
  writeFileSync(ORGANIZATIONS_FILE, JSON.stringify(organizations, null, 2), { mode: 0o600 });
}

export function createOrganization(req: CreateOrganizationRequest): Organization {
  if (!req.name || req.name.trim().length < 2) {
    throw new Error("ORGANIZATION_NAME_TOO_SHORT");
  }

  const organizations = loadOrganizations();
  const existing = organizations.find(o => o.name.trim().toLowerCase() === req.name.trim().toLowerCase());
  if (existing) {
    throw new Error("ORGANIZATION_EXISTS");
  }

  const now = Date.now();
  const organization: Organization = {
    id: "org_" + randomBytes(16).toString("hex"),
    name: req.name.trim(),
    description: req.description?.trim() || "",
    quota: {
      maxSessions: DEFAULT_QUOTA.maxSessions,
      maxEventsPerSession: DEFAULT_QUOTA.maxEventsPerSession,
    },
    createdAt: now,
    updatedAt: now,
  };

  organizations.push(organization);
  saveOrganizations(organizations);
  return organization;
}

export function listOrganizations(): Organization[] {
  return loadOrganizations();
}

export function findOrganizationById(id: string): Organization | null {
  const organizations = loadOrganizations();
  return organizations.find(o => o.id === id) || null;
}

export function updateOrganization(id: string, req: UpdateOrganizationRequest): Organization | null {
  const organizations = loadOrganizations();
  const index = organizations.findIndex(o => o.id === id);
  if (index === -1) {
    return null;
  }

  const now = Date.now();
  organizations[index] = {
    ...organizations[index],
    ...(req.name !== undefined && { name: req.name.trim() }),
    ...(req.description !== undefined && { description: req.description.trim() }),
    ...(req.quota !== undefined && {
      quota: {
        ...organizations[index].quota,
        ...(req.quota.maxSessions !== undefined && { maxSessions: req.quota.maxSessions }),
        ...(req.quota.maxEventsPerSession !== undefined && { maxEventsPerSession: req.quota.maxEventsPerSession }),
      },
    }),
    updatedAt: now,
  };

  saveOrganizations(organizations);
  return organizations[index];
}

export function deleteOrganization(id: string): boolean {
  const organizations = loadOrganizations();
  const index = organizations.findIndex(o => o.id === id);
  if (index === -1) {
    return false;
  }

  organizations.splice(index, 1);
  saveOrganizations(organizations);
  return true;
}