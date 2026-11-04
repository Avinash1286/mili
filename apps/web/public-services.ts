/** URLs are public routing configuration, never service credentials. */
export function convexPublicServices(env: Record<string, string | undefined>) {
  if (env.VERCEL && (!env.NEXT_PUBLIC_CONVEX_URL || !env.NEXT_PUBLIC_CONVEX_SITE_URL)) throw new Error('Vercel requires explicit public Convex cloud and site URLs.');
  const convexUrl = env.NEXT_PUBLIC_CONVEX_URL ?? 'http://127.0.0.1:3210';
  const convexSiteUrl = env.NEXT_PUBLIC_CONVEX_SITE_URL ?? 'http://127.0.0.1:3211';
  for (const raw of [convexUrl, convexSiteUrl]) {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || env.VERCEL && url.protocol !== 'https:') throw new Error('Invalid public Convex URL.');
  }
  return { convexUrl, convexSiteUrl };
}
