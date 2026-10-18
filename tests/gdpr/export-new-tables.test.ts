/**
 * Export coverage for the newly wiped tables (prompt D step 1): the export
 * must include connections WITHOUT any token columns, and drafts and the
 * voice profile DECRYPTED so the file is readable.
 */
import { describe, it, expect, vi } from "vitest";

const USER = "11111111-1111-1111-1111-111111111111";

const ROWS: Record<string, Array<Record<string, unknown>>> = {
  connections: [
    {
      id: "c1",
      user_id: USER,
      provider: "gmail",
      account_label: "me@example.com",
      access_token_encrypted: "secret-access",
      refresh_token_encrypted: "secret-refresh",
      expires_at: null,
      scopes: ["openid"],
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ],
  drafts: [
    {
      id: "d1",
      user_id: USER,
      source_node_id: null,
      template: "reply",
      body_encrypted: "enc-draft-body",
      chars_in_draft: 42,
      chars_edited: null,
      status: "pending",
      templates_tried: ["reply"],
      created_at: "2026-01-01T00:00:00Z",
      resolved_at: null,
    },
  ],
  voice_profiles: [
    {
      id: "v1",
      user_id: USER,
      sample_count: 200,
      built_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-08T00:00:00Z",
      profile_encrypted: "enc-voice-profile",
    },
  ],
  research_tasks: [
    { id: "r1", user_id: USER, tool_id: "research_thread_context", status: "pending" },
  ],
  user_endpoints: [
    {
      user_id: USER,
      db_url_encrypted: "secret-db",
      model_url_encrypted: "secret-model",
      model_key_encrypted: "secret-key",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ],
  watchers: [{ id: "w1", user_id: USER, kind: "web", target: "example.com" }],
};

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: async () => ({ data: ROWS[table] ?? [], error: null }),
      }),
    }),
  },
}));

vi.mock("@/server/crypto.server", () => ({
  decryptToken: (s: string) => `decrypted(${s})`,
  encryptToken: (s: string) => `enc:${s}`,
}));

const { exportAccountDataFor, EXPORT_TABLES } = await import("@/lib/gdpr.server");

describe("exportAccountDataFor — new tables", () => {
  it("includes the newly covered tables", async () => {
    for (const t of ["connections", "drafts", "voice_profiles", "research_tasks", "user_endpoints", "watchers"]) {
      expect(EXPORT_TABLES).toContain(t);
    }
    const res = await exportAccountDataFor(USER);
    const parsed = JSON.parse(res.json);
    expect(parsed.tables.connections).toHaveLength(1);
    expect(parsed.tables.drafts).toHaveLength(1);
    expect(parsed.tables.voice_profiles).toHaveLength(1);
    expect(parsed.tables.research_tasks).toHaveLength(1);
    expect(parsed.tables.watchers).toHaveLength(1);
  });

  it("never exports token or endpoint secret columns", async () => {
    const res = await exportAccountDataFor(USER);
    const parsed = JSON.parse(res.json);
    const conn = parsed.tables.connections[0];
    expect(conn.provider).toBe("gmail");
    expect(conn.account_label).toBe("me@example.com");
    expect(conn).not.toHaveProperty("access_token_encrypted");
    expect(conn).not.toHaveProperty("refresh_token_encrypted");
    const ep = parsed.tables.user_endpoints[0];
    expect(ep).not.toHaveProperty("db_url_encrypted");
    expect(ep).not.toHaveProperty("model_url_encrypted");
    expect(ep).not.toHaveProperty("model_key_encrypted");
    // Belt and braces: no secret material anywhere in the file.
    expect(res.json).not.toContain("secret-access");
    expect(res.json).not.toContain("secret-refresh");
    expect(res.json).not.toContain("secret-db");
    expect(res.json).not.toContain("secret-key");
  });

  it("exports drafts and the voice profile decrypted and readable", async () => {
    const res = await exportAccountDataFor(USER);
    const parsed = JSON.parse(res.json);
    const draft = parsed.tables.drafts[0];
    expect(draft.body).toBe("decrypted(enc-draft-body)");
    expect(draft).not.toHaveProperty("body_encrypted");
    const vp = parsed.tables.voice_profiles[0];
    expect(vp.profile).toBe("decrypted(enc-voice-profile)");
    expect(vp).not.toHaveProperty("profile_encrypted");
  });
});
