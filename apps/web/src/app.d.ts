import type { Role } from '@thalermark/validation';

declare global {
  namespace App {
    interface Locals {
      session: Session | null;
      activeAccountId?: string;
      // The active workspace membership's role, resolved alongside
      // activeAccountId in hooks.server.ts. Drives UX capability gating; the
      // API stays authoritative. Absent until an active workspace is resolved.
      role?: Role;
    }
    interface PageData {
      session: Session | null;
      activeAccountId?: string;
      role?: Role;
    }
  }
}

export type Membership = {
  accountId: string;
  name: string;
  role: Role;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  lastAccountId: string | null;
};

export type Session = {
  user: SessionUser;
  memberships: Membership[];
};
