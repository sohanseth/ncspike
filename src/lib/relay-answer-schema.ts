import { z } from "zod";

function base64Length(value: string, length: number): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  try { return atob(value).length === length && btoa(atob(value)) === value; } catch { return false; }
}
export const relayAnswersSchema = z.object({ v: z.literal(1), ack: z.array(z.string().uuid()).max(200) }).strict();
export const relayAnswerSchema = z.object({
  deviceId: z.string().uuid(),
  keyId: z.string().regex(/^[0-9a-f]{8}$/),
  ref: z.string().regex(/^[0-9a-f]{24}$/),
  nonce: z.string().refine((s) => base64Length(s, 12)),
  ciphertext: z.string().refine((s) => base64Length(s, 272)),
}).strict();
export type RelayAnswerInput = z.infer<typeof relayAnswerSchema>;