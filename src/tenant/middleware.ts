import { Request, Response, NextFunction } from "express";
import { listOrganizations } from "./organization";
import { getUserRoleInOrganization, getOrganizationsByUserId } from "./member";
import type { OrgRole } from "./types";

declare global {
  namespace Express {
    interface Request {
      organizationId?: string;
      orgRole?: OrgRole;
      userOrganizations?: string[];
    }
  }
}

export function requireOrganizationAccess(allowAdmin = true) {
  return async (req: Request, res: Response<any, Record<string, any>>, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const organizationId = req.params.id || req.query.organizationId || req.body.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "ORGANIZATION_ID_REQUIRED" });
      return;
    }

    if (allowAdmin && req.user.role === "admin") {
      req.organizationId = organizationId as string;
      req.orgRole = "admin";
      next();
      return;
    }

    const orgRole = getUserRoleInOrganization(req.user.id, organizationId as string);
    if (!orgRole) {
      res.status(403).json({ error: "NOT_MEMBER_OF_ORGANIZATION" });
      return;
    }

    req.organizationId = organizationId as string;
    req.orgRole = orgRole;
    next();
  };
}

export function requireOrgRole(role: OrgRole) {
  return async (req: Request, res: Response<any, Record<string, any>>, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    if (req.user.role === "admin") {
      next();
      return;
    }

    const organizationId = req.organizationId || req.params.id;
    if (!organizationId) {
      res.status(400).json({ error: "ORGANIZATION_ID_REQUIRED" });
      return;
    }

    const orgRole = getUserRoleInOrganization(req.user.id, organizationId);
    if (!orgRole) {
      res.status(403).json({ error: "NOT_MEMBER_OF_ORGANIZATION" });
      return;
    }

    if (orgRole === "admin" || orgRole === role) {
      req.orgRole = orgRole;
      next();
      return;
    }

    res.status(403).json({ error: "FORBIDDEN" });
  };
}

export function attachUserOrganizations() {
  return async (req: Request, _res: unknown, next: NextFunction) => {
    if (!req.user) {
      next();
      return;
    }

    if (req.user.role === "admin") {
      req.userOrganizations = listOrganizations().map(o => o.id);
      next();
      return;
    }

    req.userOrganizations = getOrganizationsByUserId(req.user.id);
    next();
  };
}