import type { AuthConfig } from 'convex/server';
export default {
  providers: process.env.TOKAI_SERVICE_JWKS ? [{
    type: 'customJwt', issuer: process.env.TOKAI_SERVICE_ISSUER ?? 'http://localhost:4000',
    applicationID: 'tokai-convex', algorithm: 'RS256',
    jwks: `data:application/json;base64,${process.env.TOKAI_SERVICE_JWKS}`,
  }] : [],
} satisfies AuthConfig;
