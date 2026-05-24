declare global {
  namespace App {
    interface Locals {
      session: Session | null;
      activeAccountId?: string;
    }
    interface PageData {
      session: Session | null;
      activeAccountId?: string;
    }
  }
}

export type Membership = {
  accountId: string;
  name: string;
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
