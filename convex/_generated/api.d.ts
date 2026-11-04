/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as guards from "../guards.js";
import type * as http from "../http.js";
import type * as job_policy from "../job_policy.js";
import type * as jobs from "../jobs.js";
import type * as maintenance from "../maintenance.js";
import type * as nativeAuth from "../nativeAuth.js";
import type * as native_auth_policy from "../native_auth_policy.js";
import type * as recovery from "../recovery.js";
import type * as storage from "../storage.js";
import type * as store from "../store.js";
import type * as tickets from "../tickets.js";
import type * as transfers from "../transfers.js";
import type * as usage from "../usage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  guards: typeof guards;
  http: typeof http;
  job_policy: typeof job_policy;
  jobs: typeof jobs;
  maintenance: typeof maintenance;
  nativeAuth: typeof nativeAuth;
  native_auth_policy: typeof native_auth_policy;
  recovery: typeof recovery;
  storage: typeof storage;
  store: typeof store;
  tickets: typeof tickets;
  transfers: typeof transfers;
  usage: typeof usage;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
