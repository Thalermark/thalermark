declare global {
  namespace App {
    interface Locals {
      session: Session | null;
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
