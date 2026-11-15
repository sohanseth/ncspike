// "Check the message reader": the reader on invented messages with known answers (reader-check-messages.ts), run
// on the phone with the rules alone and with Apple's model, timed. The summary holds only numbers and the invented
// messages' ids and titles, so it's safe to share: it's how Apple's model is measured on a real iPhone.
import { findInMessage, type ModelCall } from "./family-engine";
import { scoreMessage, total, type MessageScore, type TestMessage } from "./score-lib";
import { CHECK_MESSAGES } from "./reader-check-messages";

export interface Totals {
  want: number;
  found: number;
  named: number;
  unwanted: number;
}
export interface CheckRow {
  id: string;
  rules: MessageScore;
  ms?: number;
  modelError?: string;
  model?: MessageScore; // what the parent would see: the model's items, then the rules'
  modelOwn?: MessageScore; // the model's items alone, to decide how to show the rest
}
export interface CheckResult {
  rules: Totals;
  model: Totals | null;
  modelOwn: Totals | null;
  modelReason: string;
  rows: CheckRow[];
  secondsPerMessage: number | null;
}

export async function runReaderCheck(
  model: ModelCall | null,
  opts: {
    modelReason?: string;
    messages?: TestMessage[];
    onProgress?: (done: number, of: number) => void;
    now?: () => number;
  } = {},
): Promise<CheckResult> {
  const messages = opts.messages || CHECK_MESSAGES;
  const now = opts.now || (() => Date.now());
  const rows: CheckRow[] = [];
  let ms = 0,
    timed = 0;
  for (const [n, m] of messages.entries()) {
    const ask = { today: m.today, children: m.children || [] };
    const row: CheckRow = {
      id: m.id,
      rules: scoreMessage(m, (await findInMessage(m.text, { ...ask, model: null })).items),
    };
    if (model) {
      let lastError = "";
      const watched: ModelCall = async (part, instructions) => {
        try {
          return await model(part, instructions);
        } catch (e) {
          lastError = String((e as Error)?.message || e).slice(0, 120);
          throw e;
        }
      };
      const start = now();
      const r = await findInMessage(m.text, { ...ask, model: watched });
      row.ms = now() - start;
      ms += row.ms;
      timed++;
      row.model = scoreMessage(m, r.items);
      row.modelOwn = scoreMessage(
        m,
        r.items.filter((i) => i.foundBy === "model"),
      );
      if (!r.usedModel) row.modelError = lastError || "the model wasn't used";
    }
    rows.push(row);
    opts.onProgress?.(n + 1, messages.length);
  }
  return {
    rules: total(rows.map((r) => r.rules)),
    model: model ? total(rows.map((r) => r.model!)) : null,
    modelOwn: model ? total(rows.map((r) => r.modelOwn!)) : null,
    modelReason: model ? "" : opts.modelReason || "Apple's model isn't available.",
    rows,
    secondsPerMessage: timed ? Math.round(ms / timed / 100) / 10 : null,
  };
}

/** The result as plain text to copy and send: numbers and invented examples only. */
export function checkSummary(r: CheckResult, when = new Date()): string {
  const line = (t: Totals) =>
    `found ${t.found} of ${t.want}, well named ${t.named}, ${t.unwanted} unwanted`;
  const out = [
    `Message reader check, ${when.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `Rules alone: ${line(r.rules)}`,
    r.model
      ? `With Apple's model: ${line(r.model)}, ${r.secondsPerMessage} s a message`
      : `Apple's model: not used (${r.modelReason})`,
  ];
  if (r.modelOwn) out.push(`Apple's model's own items: ${line(r.modelOwn)}`);
  for (const row of r.rows) {
    const s = row.model || row.rules;
    for (const x of s.misses) out.push(`  missed ${row.id}: ${x}`);
    for (const x of s.extras) out.push(`  unwanted ${row.id}: ${x}`);
    if (row.modelError) out.push(`  model error ${row.id}: ${row.modelError}`);
  }
  return out.join("\n");
}
