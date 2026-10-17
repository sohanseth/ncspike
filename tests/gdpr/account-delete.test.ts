/**
 * Account deletion (prompt D step 1) — the delete must remove the ACCOUNT,
 * not just rows: sessions signed out, Google tokens revoked at Google,
 * every Storage object under the user's folder wiped (across pages and
 * subfolders), all per-user rows via delete_user_data, then the sign-in
 * itself. And it must REFUSE to delete the sign-in while any stored object
 * remains.
 *
 * Runs offline against a hand-built supabaseAdmin mock; the real-DB side is
 * covered by gdpr-roundtrip-realdb.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const USER = "11111111-1111-1111-1111-111111111111";

// ─── Mutable mock state ─────────────────────────────────────────────────────

type StorageEntry = { name: string; id: string | null; created_at?: string };

const state = {
  signOutCalls: [] as Array<{ token: string; scope?: string }>,
  deleteUserCalls: [] as string[],
  rpcCalls: [] as string[],
  revokeCalls: [] as string[],
  removedPaths: [] as string[],
  /** bucket -> folder path -> pages of entries */
  storageTree: new Map<string, StorageEntry[]>(),
  connections: [] as Array<{
    id: string;
    provider: string;
    access_token_encrypted: string | null;
    refresh_token_encrypted: string | null;
  }>,
  revokeFailOn: new Set<string>(), // tokens whose revocation should fail
  rpcResult: { connections_deleted: 2, drafts_deleted: 1 } as Record<string, number>,
};

function listFolder(bucket: string, path: string, offset: number, limit: number) {
  const all = state.storageTree.get(`${bucket}:${path}`) ?? [];
  return all.slice(offset, offset + limit);
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        signOut: async (token: string, scope?: string) => {
          state.signOutCalls.push({ token, scope });
          return { error: null };
        },
        deleteUser: async (userId: string) => {
          state.deleteUserCalls.push(userId);
          return { error: null };
        },
      },
    },
    from: (table: string) => {
      if (table !== "connections") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: async () => ({ data: state.connections, error: null }),
        }),
      };
    },
    rpc: async (name: string) => {
      state.rpcCalls.push(name);
      return { data: [state.rpcResult], error: null };
    },
    storage: {
      from: (bucket: string) => ({
        list: async (path: string, opts?: { limit?: number; offset?: number }) => ({
          data: listFolder(bucket, path, opts?.offset ?? 0, opts?.limit ?? 1000),
          error: null,
        }),
        remove: async (paths: string[]) => {
          state.removedPaths.push(...paths);
          for (const p of paths) {
            const idx = p.lastIndexOf("/");
            const dir = p.slice(0, idx);
            const name = p.slice(idx + 1);
            const key = `${bucket}:${dir}`;
            const entries = state.storageTree.get(key) ?? [];
            state.storageTree.set(key, entries.filter((e) => e.name !== name));
          }
          return { error: null };
        },
      }),
    },
  },
}));

vi.mock("@/server/crypto.server", () => ({
  decryptToken: (s: string) => `dec:${s}`,
  encryptToken: (s: string) => `enc:${s}`,
}));

// fetch mock for Google revocation
vi.stubGlobal("fetch", async (url: string, init?: { body?: URLSearchParams }) => {
  if (String(url).includes("oauth2.googleapis.com/revoke")) {
    const token = init?.body?.get("token") as string;
    state.revokeCalls.push(token);
    if (state.revokeFailOn.has(token)) return { ok: false, status: 400 };
    return { ok: true, status: 200 };
  }
  throw new Error(`unexpected fetch ${url}`);
});

const { deleteAccountFor, wipeUserStorage, revokeGoogleTokens } = await import(
  "@/lib/gdpr.functions"
);

beforeEach(() => {
  state.signOutCalls = [];
  state.deleteUserCalls = [];
  state.rpcCalls = [];
  state.revokeCalls = [];
  state.removedPaths = [];
  state.storageTree = new Map();
  state.connections = [];
  state.revokeFailOn = new Set();
});

describe("deleteAccountFor", () => {
  it("signs out every session globally before anything else", async () => {
    await deleteAccountFor(USER, "access-token-abc");
    expect(state.signOutCalls).toEqual([{ token: "access-token-abc", scope: "global" }]);
  });

  it("revokes every Google token (refresh preferred over access) and deletes the sign-in last", async () => {
    state.connections = [
      { id: "1", provider: "gmail", access_token_encrypted: "ga", refresh_token_encrypted: "gr" },
      { id: "2", provider: "google_calendar", access_token_encrypted: "ca", refresh_token_encrypted: null },
    ];
    const res = await deleteAccountFor(USER, "tok");
    expect(state.revokeCalls).toEqual(["dec:gr", "dec:ca"]);
    expect(state.rpcCalls).toEqual(["delete_user_data"]);
    expect(state.deleteUserCalls).toEqual([USER]);
    expect(res.googleRevokeFailed).toBe(false);
    expect(res.perTable.connections).toBe(2);
  });

  it("carries on when a revocation fails and reports it", async () => {
    state.connections = [
      { id: "1", provider: "gmail", access_token_encrypted: "ga", refresh_token_encrypted: "gr" },
      { id: "2", provider: "google_calendar", access_token_encrypted: "ca", refresh_token_encrypted: "cr" },
    ];
    state.revokeFailOn.add("dec:gr");
    const res = await deleteAccountFor(USER, "tok");
    expect(state.revokeCalls).toEqual(["dec:gr", "dec:cr"]); // tried both
    expect(res.googleRevokeFailed).toBe(true);
    expect(state.deleteUserCalls).toEqual([USER]); // still completed
  });

  it("wipes every storage object across pages and subfolders, then deletes rows and the sign-in", async () => {
    // Root folder: 1001 files (forces a second page) + one subfolder.
    const rootEntries: StorageEntry[] = [
      ...Array.from({ length: 1001 }, (_, i) => ({
        name: `f${i}.bin`,
        id: `id-${i}`,
      })),
      { name: "imagegen", id: null },
    ];
    state.storageTree.set(`chat-attachments:${USER}`, rootEntries);
    state.storageTree.set(`chat-attachments:${USER}/imagegen`, [
      { name: "a.png", id: "img-a" },
      { name: "b.png", id: "img-b" },
    ]);

    await deleteAccountFor(USER, "tok");

    expect(state.removedPaths).toHaveLength(1003);
    expect(state.removedPaths).toContain(`${USER}/imagegen/a.png`);
    expect(state.removedPaths).toContain(`${USER}/f1000.bin`);
    // Storage is empty afterwards (mock remove actually removes).
    expect(listFolder("chat-attachments", USER, 0, 2000).filter((e) => e.id !== null)).toHaveLength(0);
    expect(state.rpcCalls).toEqual(["delete_user_data"]);
    expect(state.deleteUserCalls).toEqual([USER]);
  });

  it("refuses to delete the sign-in while any object remains", async () => {
    state.storageTree.set(`chat-attachments:${USER}`, [
      { name: "stuck.bin", id: "x" },
    ]);
    // Sabotage remove: the file comes back (simulating a failed delete).
    const origRemove = state.removedPaths;
    void origRemove;
    // Re-mock remove to no-op by making list always return the file:
    // easiest is to make remove a no-op for this test.
    const mod = await import("@/integrations/supabase/client.server");
    const storage = (mod.supabaseAdmin as any).storage;
    const orig = storage.from;
    storage.from = (bucket: string) => ({
      list: orig(bucket).list,
      remove: async () => ({ error: null }), // does NOT delete
    });
    try {
      await expect(deleteAccountFor(USER, "tok")).rejects.toThrow(/storage wipe incomplete/);
      expect(state.rpcCalls).toEqual([]); // rows untouched
      expect(state.deleteUserCalls).toEqual([]); // sign-in untouched
    } finally {
      storage.from = orig;
    }
  });
});

describe("revokeGoogleTokens", () => {
  it("ignores non-Google connections", async () => {
    state.connections = [
      { id: "1", provider: "slack", access_token_encrypted: "sa", refresh_token_encrypted: null },
    ];
    const res = await revokeGoogleTokens(USER);
    expect(res.failed).toBe(false);
    expect(state.revokeCalls).toEqual([]);
  });
});

describe("wipeUserStorage", () => {
  it("is a no-op when the user has no files", async () => {
    await expect(wipeUserStorage(USER)).resolves.toBeUndefined();
    expect(state.removedPaths).toEqual([]);
  });
});
