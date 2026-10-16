import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MAX_MISSION_BODY, missionUpsertSchema, missionDeleteSchema, missionResultsSchema } from "@/lib/relay-mission-schema";
import { ResearchDigestConfigSchema, researchDigest } from "@/server/agents/templates/research-digest";
import { json, sha256 } from "./relay.server";

export type MissionAction = "upsert" | "delete" | "results";
type DB = SupabaseClient<Database>;
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
class RequestError extends Error { constructor(public status: number) { super("Invalid request"); } }
async function readBody(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_MISSION_BODY) throw new RequestError(413);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MISSION_BODY) { await reader.cancel(); throw new RequestError(413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new RequestError(400); }
}
const text = (v: unknown) => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
export function missionResults(payload: unknown, since: string, origin: string) {
  const data = object(payload);
  if (!data || !Array.isArray(data.runs) || !object(data.states)) throw new Error("Invalid mission results");
  const runs = data.runs.map(object);
  const results: Array<{ missionId: string; id: string; title: string; summary: string; url: string; createdAt: string }> = [];
  for (const run of runs) {
    if (!run) throw new Error("Invalid run");
    const briefing = object(run.briefing);
    if (typeof run.itemsKept !== "number" || run.itemsKept <= 0 || !briefing || "failureClass" in briefing) continue;
    let title = ""; let summary = "";
    if (briefing.version === 3) {
      const notes = Array.isArray(briefing.keepInMind) ? briefing.keepInMind.map((n) => text(object(n)?.text)) : [];
      const whatsNew = text(briefing.whatsNew);
      title = whatsNew || notes[0] || "";
      summary = (whatsNew ? notes : notes.slice(1)).join(" ");
    } else if (briefing.version === 2) {
      title = text(briefing.headline); summary = text(briefing.synthesis);
    } else continue;
    if (typeof run.missionId !== "string" || typeof run.runId !== "string" || typeof run.agentId !== "string" || typeof run.finishedAt !== "string") throw new Error("Invalid run");
    results.push({ missionId: run.missionId, id: run.runId, title: title.slice(0, 200), summary: text(summary).slice(0, 600), url: `${origin}/workspace/agents/${run.agentId}`, createdAt: new Date(run.finishedAt).toISOString() });
  }
  const last = runs.at(-1);
  if (last && typeof last.finishedAt !== "string") throw new Error("Invalid cursor");
  return { results, until: last ? new Date(String(last.finishedAt)).toISOString() : since, states: data.states };
}
export async function handleRelayMission(request: Request, action: MissionAction, db: DB): Promise<Response> {
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new RequestError(415);
    if (Number(request.headers.get("content-length")) > MAX_MISSION_BODY) throw new RequestError(413);
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{32,512})$/)?.[1];
    if (!token) throw new RequestError(401);
    const device = await db.from("relay_devices").select("id").eq("token_hash", await sha256(token)).is("revoked_at", null).maybeSingle();
    if (device.error || !device.data) throw new RequestError(401);
    const body = await readBody(request);
    if (action === "upsert") {
      const parsed = missionUpsertSchema.safeParse(body);
      if (!parsed.success) throw new RequestError(400);
      const m = parsed.data.mission;
      const { data, error } = await db.rpc("relay_mission_upsert", { p_device: device.data.id, p_mission_id: m.id, p_name: m.name, p_config: ResearchDigestConfigSchema.parse({ topics: m.topics }), p_hours: m.cadence === "weekly" ? 168 : 24, p_paused: m.status === "paused", p_badge: researchDigest.defaultBadge, p_budget: researchDigest.defaultBudget });
      const result = object(data);
      if (error || !result) throw new Error("Upsert failed");
      if (result.status === "revoked") throw new RequestError(401);
      if (result.status === "too_many") return json({ error: "too many" }, 409);
      if (result.status !== "ok" || typeof result.agentState !== "string") throw new Error("Upsert failed");
      return json({ ok: true, agentState: result.agentState });
    }
    if (action === "delete") {
      const parsed = missionDeleteSchema.safeParse(body);
      if (!parsed.success) throw new RequestError(400);
      const { data, error } = await db.rpc("relay_mission_delete", { p_device: device.data.id, p_mission_id: parsed.data.missionId });
      if (error || typeof data !== "boolean") throw new Error("Delete failed");
      return json({ ok: true, deleted: data });
    }
    const parsed = missionResultsSchema.safeParse(body);
    if (!parsed.success) throw new RequestError(400);
    const { data, error } = await db.rpc("relay_mission_runs", { p_device: device.data.id, p_since: parsed.data.since });
    if (error) throw new Error("Results failed");
    return json(missionResults(data, parsed.data.since, new URL(request.url).origin));
  } catch (error) {
    if (error instanceof RequestError) return json({ error: ({ 400: "Invalid request", 401: "Unauthorized", 413: "Body too large", 415: "Expected application/json" } as Record<number, string>)[error.status] }, error.status);
    return json({ error: "Connection temporarily unavailable" }, 503);
  }
}