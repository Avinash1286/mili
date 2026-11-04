/** Explicit public connection destinations. Provider credentials never belong in these settings. */
import { convexPublicServices } from './public-services';
export function securityHeaders(env: Record<string, string | undefined>) {
  const development = env.NODE_ENV !== 'production', connections = new Set<string>(["'self'"]), forms = new Set<string>(["'self'"]);
  const add = (raw: string | undefined, form = false) => {
    if (!raw || raw === '/') return;
    const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid public service URL');
    connections.add(url.origin); if (form) forms.add(url.origin);
    const socket = new URL(url.origin); socket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; connections.add(socket.origin);
    if (url.hostname.endsWith('.convex.cloud')) { url.hostname = url.hostname.replace(/\.convex\.cloud$/, '.convex.site'); connections.add(url.origin); }
  };
  const { convexUrl, convexSiteUrl } = convexPublicServices(env);
  add(env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000', true); add(convexUrl); add(convexSiteUrl);
  if (development) { add('http://localhost:3000'); add('http://localhost:4000', true); add('http://127.0.0.1:3210'); add('http://127.0.0.1:3211'); }
  const policy = ["default-src 'self'", `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' data: https://fonts.gstatic.com", "img-src 'self' data: blob:",
    "media-src 'self' blob:", "worker-src 'self' blob:", `connect-src ${[...connections].join(' ')}`, `form-action ${[...forms].join(' ')}`,
    "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'"].join('; ');
  return [
    { key: 'Content-Security-Policy', value: policy }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }, { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(), payment=()' },
  ];
}
