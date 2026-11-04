import type { AuthConfig } from 'convex/server';
import { getAuthConfigProvider } from '@convex-dev/better-auth/auth-config';
export default {
  providers: [...(process.env.TOKAI_SERVICE_JWKS ? [{
    type: 'customJwt' as const, issuer: process.env.TOKAI_SERVICE_ISSUER ?? 'http://localhost:4000',
    applicationID: 'tokai-convex', algorithm: 'RS256' as const,
    jwks: `data:application/json;base64,${process.env.TOKAI_SERVICE_JWKS}`,
  }] : []), ...(process.env.BETTER_AUTH_SECRET ? [getAuthConfigProvider()] : [])],
} satisfies AuthConfig;
