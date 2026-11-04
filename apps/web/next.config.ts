import type { NextConfig } from 'next';
import { securityHeaders } from './security';
const config: NextConfig = { transpilePackages: ['@milli/contracts'], poweredByHeader: false, async headers() { return [{ source: '/:path*', headers: securityHeaders(process.env) }]; } };
export default config;
