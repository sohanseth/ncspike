import { z } from "zod";

export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const MAX_RELAY_BODY = 400 * 1024;
export const normalizePairingCode = (code: string) => code.replace(/[-\s]/g, "").toUpperCase();
export const claimSchema = z.object({
  v: z.literal(1),
  code: z.string().max(128).transform(normalizePairingCode).pipe(z.string().regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/)),
  deviceName: z.string().trim().min(1).max(40),
});

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/)
  .refine((s) => Number.isFinite(Date.parse(s)), "Invalid timestamp");
function base64Bytes(value: string): number {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return -1;
  try { return atob(value).length; } catch { return -1; }
}
const cardSchema = z.object({
  ref: z.string().regex(/^[0-9a-f]{24}$/),
  nonce: z.string().max(24).refine((s) => base64Bytes(s) === 12, "Invalid nonce"),
  ciphertext: z.string().max(21848).refine((s) => { const n = base64Bytes(s); return n >= 16 && n <= 16384; }, "Invalid ciphertext"),
  order: z.number().int().min(0).max(19),
  expiresAt: timestamp.refine((s) => { const delta = Date.parse(s) - Date.now(); return delta > 0 && delta <= 4 * 86400000; }, "Invalid expiry"),
});
export const publishSchema = z.object({
  v: z.literal(1), seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  keyId: z.string().regex(/^[0-9a-f]{8}$/), generatedAt: timestamp,
  cards: z.array(cardSchema).max(20),
}).refine(({ cards }) => new Set(cards.map((c) => c.ref)).size === cards.length && new Set(cards.map((c) => c.order)).size === cards.length, "Duplicate ref or order");
export type RelayPublish = z.infer<typeof publishSchema>;