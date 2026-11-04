import { z } from 'zod';

export const DictationStreamClientSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), token: z.string().min(1).max(4096).optional(), sessionId: z.string().min(1).max(120) }).strict(),
  z.object({ type: z.literal('finish') }).strict(),
]);
export const DictationStreamServerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('transcript'), text: z.string().min(1).max(3000) }).strict(),
  z.object({ type: z.literal('error'), message: z.string().min(1).max(300) }).strict(),
]);
