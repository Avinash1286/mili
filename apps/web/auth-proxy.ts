/** Only native-library credentials may cross from the app origin to Convex Auth. */
export async function nativeAuthProxyRequest(request: Request): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.delete('x-vercel-protection-bypass');
  headers.delete('x-vercel-set-bypass-cookie');
  headers.delete('authorization');
  const cookies = (headers.get('cookie') ?? '').split(';').map(cookie => cookie.trim()).filter(cookie => /^(?:__Secure-|__Host-)?better-auth\.[A-Za-z0-9_.-]+=/.test(cookie));
  if (cookies.length) headers.set('cookie', cookies.join('; ')); else headers.delete('cookie');
  // NextRequest may be a framework proxy backed by a different Request class.
  // Construct from public primitives instead of asking undici to clone its state.
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (!['GET', 'HEAD'].includes(request.method) && request.body) {
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 65536) { await reader.cancel(); throw new RangeError('Native authentication request exceeds 64KiB.'); } chunks.push(chunk.value); }
    body = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  }
  return new Request(request.url, { method: request.method, headers, ...(body ? { body } : {}) });
}
