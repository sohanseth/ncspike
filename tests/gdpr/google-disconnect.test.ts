/**
 * Google disconnect semantics (prompt D step 2). Gmail and Calendar share
 * one Google sign-in, and revoking the token kills both — so disconnecting
 * one while the other remains must NOT revoke, disconnecting the last one
 * must try to revoke, and the row is deleted either way.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const USER = "11111111-1111-1111-1111-111111111111";

const state = {
  /** provider -> row (null = not connected) */
  rows: new Map<string, { access_token_encrypted: string | null; refresh_token_encrypted: string | null } | null>(),
  deleted: [] as string[],
  revokeCalls: [] as string[],
  revokeFails: false,
};

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "connections") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_c: string, _v: string) => ({
            eq: (_c2: string, provider: string) => ({
              maybeSingle: async () => ({ data: state.rows.get(provider) ?? null, error: null }),
            }),
          }),
        }),
        delete: () => ({
          eq: (_c: string, _v: string) => ({
            eq: async (_c2: string, provider: string) => {
              state.deleted.push(provider);
              state.rows.set(provider, null);
              return { error: null };
            },
          }),
        }),
      };
    },
  },
}));

vi.mock("@/server/crypto.server", () => ({
  decryptToken: (s: string) => `dec:${s}`,
  encryptToken: (s: string) => `enc:${s}`,
}));

vi.stubGlobal("fetch", async (url: string, init?: { body?: URLSearchParams }) => {
  if (String(url).includes("oauth2.googleapis.com/revoke")) {
    state.revokeCalls.push(init?.body?.get("token") as string);
    return { ok: !state.revokeFails, status: state.revokeFails ? 400 : 200 };
  }
  throw new Error(`unexpected fetch ${url}`);
});

const { disconnectProviderFor } = await import("@/lib/gmail.server");

beforeEach(() => {
  state.rows = new Map();
  state.deleted = [];
  state.revokeCalls = [];
  state.revokeFails = false;
});

describe("disconnectProviderFor", () => {
  it("keeps the shared token when the other Google connection remains", async () => {
    state.rows.set("gmail", { access_token_encrypted: "ga", refresh_token_encrypted: "gr" });
    state.rows.set("google_calendar", { access_token_encrypted: "ca", refresh_token_encrypted: null });
    const res = await disconnectProviderFor(USER, "gmail");
    expect(res.otherGoogleRemain).toBe(true);
    expect(res.revokeFailed).toBe(false);
    expect(state.revokeCalls).toEqual([]); // token NOT revoked
    expect(state.deleted).toEqual(["gmail"]); // row still deleted
  });

  it("revokes the token when the last Google connection goes", async () => {
    state.rows.set("gmail", { access_token_encrypted: "ga", refresh_token_encrypted: "gr" });
    state.rows.set("google_calendar", null);
    const res = await disconnectProviderFor(USER, "gmail");
    expect(res.otherGoogleRemain).toBe(false);
    expect(state.revokeCalls).toEqual(["dec:gr"]); // refresh token preferred
    expect(state.deleted).toEqual(["gmail"]);
  });

  it("still deletes the row when revocation fails", async () => {
    state.rows.set("gmail", { access_token_encrypted: "ga", refresh_token_encrypted: "gr" });
    state.revokeFails = true;
    const res = await disconnectProviderFor(USER, "gmail");
    expect(res.revokeFailed).toBe(true);
    expect(state.deleted).toEqual(["gmail"]);
  });
});
