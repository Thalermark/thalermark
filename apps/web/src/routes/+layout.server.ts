import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
  return {
    session: locals.session,
    activeAccountId: locals.activeAccountId,
    role: locals.role,
    notice: locals.notice ?? null,
  };
};
