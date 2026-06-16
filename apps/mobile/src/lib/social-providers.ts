import { useEffect, useState } from 'react';
import { api } from './api';

// The social providers the api reports as configured (GET /api/social-providers,
// a public route). Two consumers — the social sign-in buttons and the sign-in
// wrong-method hint — so the fetch lives here once. Best-effort: a failure just
// yields an empty list (email/password still works). Mirrors web, where the same
// list comes from the (auth) layout load.
export function useSocialProviders(): string[] {
  const [providers, setProviders] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    api.api['social-providers']
      .$get()
      .then(async (res) => {
        if (active && res.ok) setProviders((await res.json()).providers);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return providers;
}
