import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute, sep } from 'node:path';
const root = resolve(process.env.TOKAI_RUNTIME_VERIFY_ROOT);
// A verification-only guard prevents success through dependencies outside the traced bundle.
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('file:')) {
    const name = relative(root, fileURLToPath(result.url));
    if (name === '..' || name.startsWith('..' + sep) || isAbsolute(name)) throw new Error('A runtime dependency escaped the traced bundle.');
  }
  return result;
} });
