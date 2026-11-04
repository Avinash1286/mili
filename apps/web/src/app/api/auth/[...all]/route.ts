import { convexBetterAuthNextJs } from '@convex-dev/better-auth/nextjs';
import { convexPublicServices } from '../../../../../public-services';
const { handler } = convexBetterAuthNextJs(convexPublicServices(process.env));
export const GET = handler.GET;
export const POST = handler.POST;
