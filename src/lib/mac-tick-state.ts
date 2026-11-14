export function pruneTicks(value: unknown, refs: readonly string[], now = Date.now()): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([ref, time]) => refs.includes(ref) && typeof time === "number" && time > now - 4 * 86400000 && time <= now));
}
export function readTicks(refs: readonly string[]): Record<string, number> {
  try { return pruneTicks(JSON.parse(localStorage.getItem("nc-ticked") || "{}"), refs); } catch { return {}; }
}
export function saveTicks(ticks: Record<string, number>) {
  try { localStorage.setItem("nc-ticked", JSON.stringify(ticks)); } catch { /* Device storage may be unavailable. */ }
}