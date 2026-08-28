import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';

// The API base URL for calls made FROM THE BROWSER.
//
// Three cases, and the third is why this exists (TMC-237):
//
//  1. PUBLIC_API_URL set        → use it. A split-origin deployment.
//  2. PUBLIC_API_URL empty ("") → relative /api/*. This is the self-host
//     default, where Caddy serves the api and the web app on one origin, and it
//     must keep working — hence `??` rather than `||`, since an empty string is
//     a real answer here and not a missing one.
//  3. PUBLIC_API_URL unset      → previously 'http://localhost:3000', which in a
//     production build means every browser request, INCLUDING THE SIGN-UP POST
//     THAT CARRIES A PASSWORD, is aimed at the visitor's own machine. Silently:
//     the app looks fine until someone tries to use it.
//
// Case 3 now resolves to relative in a production build. Same-origin is what a
// misconfigured deploy almost certainly wanted, it is what case 2 already does,
// and being wrong that way is a broken request rather than credentials pointed
// somewhere they should never go. The localhost convenience stays in dev, where
// it is correct and where `dev` is compiled to true.
//
// This cannot be a build-time check: the web image is deliberately built once
// and run across deployments, reading this at request time (apps/web/Dockerfile).
export const publicApiBaseUrl: string = env.PUBLIC_API_URL ?? (dev ? 'http://localhost:3000' : '');
