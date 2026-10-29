/**
 * deep-link — shared `?page=…` reader for the staff + patient apps.
 *
 * The apps use HASH routing (`#/reception?page=create`), but every
 * reader used to parse `window.location.search` only. In a hash URL
 * the query string is part of the FRAGMENT, so `location.search` is
 * empty and the deep link silently fell back to the default view.
 *
 * `readDeepLinkParam` therefore checks the hash fragment FIRST (the
 * form the app actually uses), then the search string (the plain
 * `/?page=create` form, still useful when someone hand-writes it).
 */
import { useEffect, useState } from 'react';

/**
 * Collect query params from both the hash fragment and the search
 * string. Hash wins on conflict, because that is the URL shape the
 * app itself generates.
 */
export function readDeepLinkParams(): URLSearchParams {
  const merged = new URLSearchParams();
  if (typeof window === 'undefined') return merged;

  const hash = window.location.hash;
  const qIndex = hash.indexOf('?');
  if (qIndex !== -1) {
    new URLSearchParams(hash.slice(qIndex + 1)).forEach((v, k) => {
      merged.set(k, v);
    });
  }
  new URLSearchParams(window.location.search).forEach((v, k) => {
    merged.set(k, v);
  });
  return merged;
}

/**
 * Read a single `?key=value` param from the hash fragment or the
 * search string. Returns `null` when the key is absent.
 */
export function readDeepLinkParam(key: string): string | null {
  return readDeepLinkParams().get(key);
}

/**
 * Reactive version of `readDeepLinkParam`.
 *
 * The staff + patient apps read their deep link ONCE, in a mount
 * effect. But the app component stays mounted across a hash-only
 * navigation (`page.goto('#/reception?page=create')` from
 * `#/reception?page=availability` does NOT remount anything), so the
 * mount effect never re-ran and the view never changed. This hook
 * re-reads on every `hashchange`, so a pasted URL — or a hash-only
 * navigation — lands on the right view.
 */
export function useDeepLinkParam(key: string): string | null {
  const [value, setValue] = useState<string | null>(() =>
    readDeepLinkParam(key),
  );

  useEffect(() => {
    const onChange = (): void => {
      setValue(readDeepLinkParam(key));
    };
    window.addEventListener('hashchange', onChange);
    // The hash may already have changed between the initial render
    // and this effect running — re-read once to close that gap.
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, [key]);

  return value;
}
