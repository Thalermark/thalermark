// "Workspace" is the user-facing label for the tenant. In code the tenant is
// still `account` (the `accounts` table, `account_id`, the `x-account-id`
// header, the `active_account_id` cookie, `app.current_account_id`) — those are
// load-bearing identifiers/wire contracts and are intentionally NOT renamed.
// account (code) == Workspace (UI). The signUp/signIn copy below keeps the word
// "account" because there it means the user's *login* account, not the tenant.
export const COPY = {
  signIn: {
    title: 'Sign in to Thalermark',
    submit: 'Sign in',
  },
  signUp: {
    title: 'Create your Thalermark account',
    submit: 'Create account',
  },
  signOut: 'Sign out',
  workspace: 'Workspace',
  activity: 'Activity',
  settings: 'Settings',
  selectCompany: {
    title: 'Choose a company',
    empty: 'You have no companies yet.',
  },
} as const;
