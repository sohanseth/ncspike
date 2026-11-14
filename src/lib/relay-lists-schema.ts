import { z } from "zod";
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const date = /^\d{4}-\d{2}-\d{2}$/;
const ref = z.string().regex(/^[0-9a-f]{24}$/);
export function decodedLength(value: string): number {
  try { const decoded = atob(value); return btoa(decoded) === value ? decoded.length : -1; } catch { return -1; }
}
export const relayListsSchema = z.object({
  v: z.literal(1), seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  keyId: z.string().regex(/^[0-9a-f]{8}$/), generatedAt: z.string().regex(timestamp),
  nonce: z.string().refine(v => decodedLength(v) === 12),
  ciphertext: z.string().refine(v => { const n = decodedLength(v); return n >= 1040 && n <= 65536 && (n - 16) % 1024 === 0; }),
  refs: z.array(ref).length(30).refine(v => v.every((r, i) => i === 0 || r > v[i - 1])),
  expiresAt: z.string().regex(timestamp).refine(v => { const delta = Date.parse(v) - Date.now(); return delta > 0 && delta <= 4 * 86400000; }),
}).strict();
export const relayListsDeleteSchema = z.object({ v: z.literal(1) }).strict();
export const macListsDocumentSchema = z.object({
  v: z.literal(1), origin: z.literal("mac"), made: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  today: z.string().regex(date), calendar: z.boolean(),
  list: z.array(z.object({ ref: ref.nullable(), title: z.string().max(200), due: z.string().regex(date).or(z.literal("")), from: z.enum(["list", "family", "reminders"]), private: z.boolean() })).max(30),
  schedule: z.array(z.object({ start: z.string().regex(/^\d{2}:\d{2}$/).or(z.literal("")), end: z.string().regex(/^\d{2}:\d{2}$/).or(z.literal("")), allDay: z.boolean(), title: z.string().max(200), private: z.boolean() })).max(30),
  coming: z.array(z.object({ date: z.string().regex(date), title: z.string().max(200), note: z.string().max(200), tone: z.enum(["", "soon"]), private: z.boolean() })).max(20),
});
export type MacListsDocument = z.infer<typeof macListsDocumentSchema>;
export type RelayListsRow = { device_id: string; key_id: string; nonce: string; ciphertext: string; expires_at: string; updated_at: string };