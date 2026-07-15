export type OrgRole = "admin" | "org-admin" | "member";

export type Organization = Readonly<{
  id: string;
  name: string;
  description: string;
  quota: {
    maxSessions: number;
    maxEventsPerSession: number;
  };
  createdAt: number;
  updatedAt: number;
}>;

export type Member = Readonly<{
  organizationId: string;
  userId: string;
  role: OrgRole;
  joinedAt: number;
}>;

export type CreateOrganizationRequest = {
  name: string;
  description?: string;
};

export type UpdateOrganizationRequest = {
  name?: string;
  description?: string;
  quota?: {
    maxSessions?: number;
    maxEventsPerSession?: number;
  };
};

export type AddMemberRequest = {
  userId: string;
  role?: OrgRole;
};

export type UpdateMemberRequest = {
  role: OrgRole;
};

export const DEFAULT_QUOTA = {
  maxSessions: 100,
  maxEventsPerSession: 10000,
} as const;