import { betterAuth } from 'better-auth/minimal';
import { createClient, type GenericCtx } from '@convex-dev/better-auth';
import { convex } from '@convex-dev/better-auth/plugins';
import { v } from 'convex/values';
import { components, internal } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import { query, mutation, internalMutation } from './_generated/server';
import authConfig from './auth.config';
import { authorize, fail, service } from './guards';
import { assertNativeAuthCapabilities, nativeAuthRequestAllowed } from './native_auth_policy';

export const nativeIssuer = 'urn:tokai:native-auth';
export const authComponent = createClient<DataModel>(components.betterAuth);
export const createAuth = (ctx: GenericCtx<DataModel>) => {
 const auth = betterAuth({
  baseURL: process.env.APP_ORIGIN ?? 'http://localhost:3000',
  secret: process.env.BETTER_AUTH_SECRET,
  logger: { disabled: true },
  database: authComponent.adapter(ctx),
  emailAndPassword: { enabled: Boolean(process.env.BETTER_AUTH_SECRET), requireEmailVerification: false, minPasswordLength: 12, maxPasswordLength: 128 },
  account: { accountLinking: { enabled: false } },
  session: { expiresIn: 7 * 86400, cookieCache: { enabled: false } },
  trustedOrigins: [process.env.APP_ORIGIN ?? 'http://localhost:3000'],
  rateLimit: { enabled: true, storage: 'database', window: 60, max: 100, customRules: { '/sign-in/email': { window: 60, max: 10 }, '/sign-up/email': { window: 60, max: 5 } } },
  plugins: [convex({ authConfig })],
 });
 assertNativeAuthCapabilities(auth.options);
 const handler = auth.handler;
 return { ...auth, handler: (request: Request) => nativeAuthRequestAllowed(request)
   ? handler(request) : Promise.resolve(new Response('Not Found', { status: 404 })) };
};

/** Validate the library session as well as its short-lived JWT. Email is never an owner key. */
export const current = query({ args: {}, handler: async ctx => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.issuer !== process.env.CONVEX_SITE_URL || typeof identity.sessionId !== 'string') fail('UNAUTHORIZED', 401, 'Sign in again.');
  const user = await authComponent.getAuthUser(ctx);
  const session = await ctx.runQuery(components.betterAuth.adapter.findOne, { model: 'session', where: [{ field: '_id', value: identity.sessionId }] });
  if (!session || session.userId !== user._id || session.expiresAt <= Date.now()) fail('UNAUTHORIZED', 401, 'Sign in again.');
  return { subject: user._id, sessionId: identity.sessionId, displayName: user.name.slice(0, 80), emailVerified: user.emailVerified, expiresAt: session.expiresAt };
} });

export const sessionActive = query({ args: { subject: v.string(), sessionId: v.string() }, handler: async (ctx, args) => {
  await service(ctx);
  const session = await ctx.runQuery(components.betterAuth.adapter.findOne, { model: 'session', where: [{ field: '_id', value: args.sessionId }] });
  if (!session || session.userId !== args.subject || session.expiresAt <= Date.now()) return false;
  return Boolean(await ctx.runQuery(components.betterAuth.adapter.findOne, { model: 'user', where: [{ field: '_id', value: args.subject }] }));
} });

/** Delete credentials immediately; bounded follow-up removes all session/account rows. */
export const deleteAccount = mutation({ args: { principal: v.any() }, handler: async (ctx, args) => {
  await service(ctx); const owner = await authorize(ctx, args.principal);
  if (owner.issuer !== nativeIssuer || !owner.subject) return;
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, { input: { model: 'user', where: [{ field: '_id', value: owner.subject }] } });
  await ctx.scheduler.runAfter(0, internal.nativeAuth.cleanup, { subject: owner.subject });
} });
export const cleanup = internalMutation({ args: { subject: v.string() }, handler: async (ctx, args) => {
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, { input: { model: 'user', where: [{ field: '_id', value: args.subject }] } });
  let more = false;
  for (const model of ['session', 'account'] as const) {
    const result = await ctx.runMutation(components.betterAuth.adapter.deleteMany, { input: { model, where: [{ field: 'userId', value: args.subject }] }, paginationOpts: { cursor: null, numItems: 100 } });
    more ||= !result.isDone;
  }
  if (more) await ctx.scheduler.runAfter(100, internal.nativeAuth.cleanup, args);
} });
