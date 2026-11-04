'use client';
import { createAuthClient } from 'better-auth/react';
import { convexClient } from '@convex-dev/better-auth/client/plugins';
export const nativeAuth = createAuthClient({ plugins: [convexClient()] });
