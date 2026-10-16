import { describe, it, expect } from "vitest";
import { claimSchema, publishSchema } from "@/lib/relay-schema";
import { hashRelayIP, normalizeRelayIP, randomPairingCode } from "@/server/relay.server";

export const payload = () => ({ v: 1, seq: 1, keyId: "12345678", generatedAt: new Date().toISOString(), cards: [{ ref: "a".repeat(24), nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==", order: 0, expiresAt: new Date(Date.now() + 60000).toISOString() }] });
describe("relay input boundaries", () => {
  it("normalizes codes and rejects invalid codes/names", () => {
    expect(claimSchema.parse({ v: 1, code: "abcd - efgh", deviceName: " Mac " }).code).toBe("ABCDEFGH");
    for (const code of ["ABCIDEFG", "ABCOEFGH", "ABC1EFGH", "ABC0EFGH", "ABC"]) expect(claimSchema.safeParse({ v: 1, code, deviceName: "Mac" }).success).toBe(false);
    expect(claimSchema.safeParse({ v: 1, code: "ABCDEFGH", deviceName: " ".repeat(41) }).success).toBe(false);
    expect(randomPairingCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });
  it("validates every encrypted envelope constraint", () => {
    expect(publishSchema.safeParse(payload()).success).toBe(true);
    const mutations = [
      (p: any) => p.seq = 0, (p: any) => p.seq = Number.MAX_SAFE_INTEGER + 1,
      (p: any) => p.keyId = "ABCDEF12", (p: any) => p.cards[0].ref = "raw title",
      (p: any) => p.cards[0].nonce = "AA==", (p: any) => p.cards[0].ciphertext = "AA==",
      (p: any) => p.cards[0].ciphertext = "!".repeat(32), (p: any) => p.cards[0].ciphertext = btoa("a".repeat(16385)),
      (p: any) => p.cards[0].order = 20, (p: any) => p.cards[0].expiresAt = new Date(Date.now() - 1000).toISOString(),
      (p: any) => p.cards[0].expiresAt = new Date(Date.now() + 5 * 86400000).toISOString(),
      (p: any) => p.cards[0].expiresAt = "2026-10-17", (p: any) => p.cards.push({ ...p.cards[0] }),
      (p: any) => p.cards = Array(21).fill(p.cards[0]), (p: any) => p.generatedAt = "yesterday",
    ];
    for (const mutate of mutations) { const p = payload(); mutate(p); expect(publishSchema.safeParse(p).success).toBe(false); }
    expect(publishSchema.safeParse({ ...payload(), cards: [] }).success).toBe(true);
  });
  it("expands IPv6 consistently before masking /64", async () => {
    expect(normalizeRelayIP("2001:db8::1")).toBe("2001:0db8:0000:0000");
    expect(normalizeRelayIP("2001:0db8:0:0:ffff:abcd:0:1234")).toBe(normalizeRelayIP("2001:db8::1"));
    expect(await hashRelayIP("2001:db8::1", "test-only")).toBe(await hashRelayIP("2001:db8::abcd", "test-only"));
    expect(await hashRelayIP("1.2.3.4", "test-only")).not.toBe(await hashRelayIP("1.2.3.5", "test-only"));
  });
});