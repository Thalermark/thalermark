import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

// Shared scaffolding for the report screens: resolve the active company once
// (single-company MVP auto-picks the first), then run the report fetcher and
// expose loading / error / data. `fetcher` returns the parsed report or null on
// a non-OK response; `deps` are the inputs (from/to or asOf) that should trigger
// a refetch. The fetcher is read through a ref so a fresh closure each render
// doesn't force it into the dep array — `deps` is the single refetch trigger.
export function useReport<T>(
  fetcher: (companyId: string) => Promise<T | null>,
  deps: unknown[],
): { data: T | null; error: boolean } {
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.companies
        .$get()
        .then(async (res) => {
          if (!active || !res.ok) return;
          const { companies } = await res.json();
          setCompanyId(companies[0]?.id ?? null);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  useEffect(() => {
    if (!companyId) return;
    let active = true;
    setData(null);
    setError(false);
    fetcherRef
      .current(companyId)
      .then((d) => {
        if (!active) return;
        if (d === null) setError(true);
        else setData(d);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [companyId, ...deps]);

  return { data, error };
}
