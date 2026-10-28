import { hrefOfUrl } from '@/lib/links';

/**
 * Links from outside the app (`makacloud://task/<id>`, `makacloud://decision/<id>`, `makacloud://`)
 * become the app's own routes; anything else opens Home. Signed out, the sign-in screen comes first.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return hrefOfUrl(path);
  } catch {
    return '/';
  }
}
