/** Temporary restricted surface while the Convex adapter requires Better Auth <1.7.
 * Review docs/phase-6-auth-dependency-review.md before adding an authentication flow. */
const paths = new Set([
  'POST /api/auth/sign-up/email', 'POST /api/auth/sign-in/email', 'POST /api/auth/sign-out',
  'GET /api/auth/get-session', 'GET /api/auth/convex/token', 'GET /api/auth/convex/jwks',
  'GET /api/auth/convex/.well-known/openid-configuration',
]);
export function nativeAuthRequestAllowed(request: Request): boolean {
  return paths.has(`${request.method} ${new URL(request.url).pathname}`);
}
export function assertNativeAuthCapabilities(options: {
  plugins?: { id: string }[]; socialProviders?: Record<string, unknown>;
  account?: { accountLinking?: { enabled?: boolean } };
}) {
  if (options.plugins?.length !== 1 || options.plugins[0]?.id !== 'convex'
    || Object.keys(options.socialProviders ?? {}).length !== 0 || options.account?.accountLinking?.enabled !== false) {
    throw new Error('Native authentication is restricted to password sessions and the Convex adapter. Review the dependency exception before enabling another flow.');
  }
}
