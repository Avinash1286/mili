import { convexBetterAuthNextJs } from '@convex-dev/better-auth/nextjs';
import { convexPublicServices } from '../../../../../public-services';
import { nativeAuthProxyRequest } from '../../../../../auth-proxy';
const { handler } = convexBetterAuthNextJs(convexPublicServices(process.env));
export const GET = async (request: Request) => handler.GET(await nativeAuthProxyRequest(request));
export const POST = async (request: Request) => handler.POST(await nativeAuthProxyRequest(request));
