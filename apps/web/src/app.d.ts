import type { Role } from '@thalermark/validation';

declare global {
  // Injected at build time by Vite `define` (apps/web/vite.config.ts): the git
  // release tag of this build, shown on Settings → About.
  const __APP_VERSION__: string;

  namespace App {
    interface Locals {
      session: Session | null;
      activeAccountId?: string;
      // The active workspace membership's role, resolved alongside
      // activeAccountId in hooks.server.ts. Drives UX capability gating; the
      // API stays authoritative. Absent until an active workspace is resolved.
      role?: Role;
      // The active account's notice, if any — the open-core account-notice seam
      // (spikes/ACCOUNT-NOTICE-SEAM.md). Resolved from the active membership in
      // hooks.server.ts and rendered as a banner in the (app) shell. Always null
      // on self-host (the community provider returns nothing).
      notice?: AccountNotice | null;
    }
    interface PageData {
      session: Session | null;
      activeAccountId?: string;
      role?: Role;
      notice?: AccountNotice | null;
    }
  }
}

// A short notice a plan-aware backend may attach to an account — the open-core
// account-notice seam. Mirrors the API's AccountNotice (apps/api/src/lib/
// account-notice.ts). Null on self-host; the commercial backend surfaces the
// frozen/lapsed → upgrade notice.
export type AccountNotice = {
  message: string;
  ctaLabel: string;
  ctaHref: string;
  variant?: 'info' | 'warning';
};

export type Membership = {
  accountId: string;
  name: string;
  role: Role;
  notice: AccountNotice | null;
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
