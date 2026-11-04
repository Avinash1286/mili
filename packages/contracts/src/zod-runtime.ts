import { z } from 'zod';

// Zod's caught Function() capability probe still violates an enforcing browser
// CSP. Configure before constructing schemas, including direct module imports.
z.config({ jitless: true });
export { z };
