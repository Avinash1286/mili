import { httpRouter } from 'convex/server';
import { content } from './transfers.js';
import { authComponent, createAuth } from './nativeAuth';
const http = httpRouter();
for (const method of ['GET', 'PUT', 'OPTIONS'] as const) http.route({ path: '/private-transfer', method, handler: content });
if (process.env.BETTER_AUTH_SECRET) authComponent.registerRoutes(http, createAuth);
export default http;
