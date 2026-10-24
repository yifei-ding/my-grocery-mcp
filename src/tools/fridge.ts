// Tools for the fridge-book (冰箱账本) receipt import. They do not call any
// chain API: they move deterministic parsing/pairing/key logic out of the
// scheduled task's prompt and into tested code.
import { z } from 'zod';
import type { AdapterRegistry } from '../adapters/registry.js';
import { buildMigrosReceiptScript } from '../fridge/browser-script.js';
import { parseCoopReceiptText } from '../fridge/receipt.js';
import { chainOf, nutriKey, SHELF_DAYS, addDaysIso } from '../fridge/fields.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const migrosReceiptScriptSchema = z.object({
  dateFrom: isoDate.optional().describe('First receipt date to list, YYYY-MM-DD. Ignored when rids is given.'),
  dateTo: isoDate.optional().describe('Last receipt date to list, YYYY-MM-DD.'),
  rids: z.array(z.string()).max(30).optional()
    .describe('Receipt transaction ids to fetch directly (e.g. already-imported receipts that still lack product ids).'),
  skip: z.array(z.string()).max(500).optional()
    .describe('Receipt transaction ids already imported; listed as skipped, not fetched.'),
}).refine((v) => (v.rids && v.rids.length) || (v.dateFrom && v.dateTo), { message: 'give rids, or dateFrom and dateTo' });

export async function migrosReceiptScriptHandler(_r: AdapterRegistry, input: z.infer<typeof migrosReceiptScriptSchema>) {
  return {
    script: buildMigrosReceiptScript(input),
    run: 'Execute `script` as-is with Claude in Chrome javascript_tool in a tab already on https://account.migros.ch/purchases/receipts (the user\'s logged-in session). Do not modify it. It returns a JSON string.',
    returns: '{ok, loggedIn, receipts:[{rid, date, store, total, matched, products, items:[{n, qty, weighed, unit, disc, p, id, u, by}]}], skipped:[rid], errors:[string]}. p = line total after discount; weighed=true → qty is kg; id/u = Migros product id and page ("" if unmatched); by = "price" | "name" | "". loggedIn=false → the user must log in again; never type credentials.',
  };
}

export const parseCoopReceiptSchema = z.object({
  text: z.string().min(1).max(200_000).describe('Text of one Coop receipt PDF after `pdftotext -layout`.'),
});

export async function parseCoopReceiptHandler(_r: AdapterRegistry, input: z.infer<typeof parseCoopReceiptSchema>) {
  const lines = parseCoopReceiptText(input.text);
  return {
    items: lines.map((l) => ({ n: l.n, qty: l.qty, weighed: l.weighed, unit: l.unit, disc: l.disc, p: l.total })),
    count: lines.length,
  };
}

const KINDS = Object.keys(SHELF_DAYS) as [string, ...string[]];

export const fridgeItemFieldsSchema = z.object({
  items: z.array(z.object({
    store: z.string().describe('Store name as on the receipt, e.g. "M Kreuzplatz", "Coop Zürich Stadelhofen".'),
    name: z.string().describe('Receipt item name (original text).'),
    de: z.string().optional().describe('Standard German name; used for the key only when name is empty after slugging.'),
    bought: isoDate.optional().describe('Purchase date, YYYY-MM-DD. Needed for expires.'),
    kind: z.enum(KINDS).optional().describe(`Shelf-life class: ${KINDS.map((k) => `${k} ${SHELF_DAYS[k]}d`).join(', ')}.`),
    shelfDays: z.number().int().min(1).max(730).optional().describe('Explicit shelf life in days; overrides kind.'),
  })).min(1).max(200),
});

export async function fridgeItemFieldsHandler(_r: AdapterRegistry, input: z.infer<typeof fridgeItemFieldsSchema>) {
  return input.items.map((it) => {
    const days = it.shelfDays ?? (it.kind ? SHELF_DAYS[it.kind] : undefined);
    return {
      name: it.name,
      chain: chainOf(it.store),
      key: nutriKey(it.store, it.name, it.de ?? ''),
      shelfDays: days ?? null,
      expires: days !== undefined && it.bought ? addDaysIso(it.bought, days) : null,
    };
  });
}
