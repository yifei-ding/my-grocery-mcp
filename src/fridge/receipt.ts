// Receipt parsing and receipt-line ↔ product pairing for the fridge-book import.
//
// Every function in this file is a self-contained `function` declaration with no
// imports and no module-level constants: browser-script.ts embeds them into the
// script that runs inside the logged-in account.migros.ch page via
// Function.prototype.toString(). Keep it that way — a helper defined outside a
// function here would be missing in the browser.

export interface ReceiptLine {
  /** Receipt text as printed, e.g. "Bio Kürbis or. Knirps". */
  n: string;
  /** Quantity column: pieces, or kg for weighed items. */
  qty: number;
  /** True when qty is a weight in kg (weighed item). */
  weighed: boolean;
  /** Unit price column (per piece or per kg). */
  unit: number;
  /** Discount column when printed (negative or positive as shown), else null. */
  disc: number | null;
  /** Line total after discount. */
  total: number;
}

export interface FlatProduct {
  id: string;
  name: string;
  price: number | null;
  link: string;
}

export interface PairedLine extends ReceiptLine {
  /** Migros 12-digit product id, "" when no product matched. */
  id: string;
  /** Product page URL, "" when no product matched. */
  u: string;
  /** How the pair was made: "price", "name" or "" (unmatched). */
  by: string;
}

/**
 * Parse the item lines of a Migros receipt (the innerText of
 * /ma/api/user/receipt/<id>?type=HTML). Items sit between the "Artikelbezeichnung"
 * header and "Zwischentotal"; each looks like `name  qty  unit  [discount]  total  vatCode`.
 * Only item lines are returned — payment, Cumulus and footer lines never are.
 */
export function parseMigrosReceiptText(text: string): ReceiptLine[] {
  const rows = String(text || '').split(/\r?\n/);
  const start = rows.findIndex((r) => /Artikelbezeichnung/i.test(r));
  if (start < 0) return [];
  const out: ReceiptLine[] = [];
  const re = /^\s*(.+?)\s{2,}(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(?:(-?\d+(?:\.\d+)?)\s+)?(-?\d+(?:\.\d+)?)\s+\d+\s*$/;
  for (let i = start + 1; i < rows.length; i++) {
    const row = rows[i];
    if (/Zwischentotal|^\s*Total\b/i.test(row)) break;
    const m = re.exec(row);
    if (!m) continue;
    const qtyText = m[2];
    out.push({
      n: m[1].trim(),
      qty: Number(qtyText),
      // Weighed items print the weight with three decimals (0.574); pieces are integers.
      weighed: /\.\d{3}$/.test(qtyText),
      unit: Number(m[3]),
      disc: m[4] === undefined ? null : Number(m[4]),
      total: Number(m[5]),
    });
  }
  return out;
}

/**
 * Parse the item lines of a Coop receipt PDF after `pdftotext -layout`. Items sit
 * between the "Artikel" header and "Total CHF"; each looks like
 * `name  qty  unit  [Aktion]  total  vatCode`.
 */
export function parseCoopReceiptText(text: string): ReceiptLine[] {
  const rows = String(text || '').split(/\r?\n/);
  const start = rows.findIndex((r) => /^\s*Artikel\b/i.test(r));
  if (start < 0) return [];
  const out: ReceiptLine[] = [];
  const re = /^\s*(.+?)\s{2,}(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(?:(-?\d+(?:\.\d+)?)\s+)?(-?\d+(?:\.\d+)?)\s+\d+\s*$/;
  for (let i = start + 1; i < rows.length; i++) {
    const row = rows[i];
    if (/Total\s+CHF/i.test(row)) break;
    const m = re.exec(row);
    if (!m) continue;
    const qtyText = m[2];
    out.push({
      n: m[1].trim(),
      qty: Number(qtyText),
      weighed: /\.\d{3}$/.test(qtyText),
      unit: Number(m[3]),
      disc: m[4] === undefined ? null : Number(m[4]),
      total: Number(m[5]),
    });
  }
  return out;
}

/**
 * Flatten the /ma/api/user/receipt/<id>/product response, an object grouped by
 * category {"<category>": [{id, name, price:{amount}, link, …}]}, into the few
 * fields the import needs. Everything else (labels, images, …) is dropped.
 */
export function flattenMigrosProducts(grouped: unknown): FlatProduct[] {
  const out: FlatProduct[] = [];
  const groups = grouped && typeof grouped === 'object'
    ? (Array.isArray(grouped) ? [grouped] : Object.values(grouped as Record<string, unknown>))
    : [];
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    for (const p of g as any[]) {
      if (!p || p.id === undefined || p.id === null) continue;
      const amount = p.price && typeof p.price === 'object' ? p.price.amount : p.price;
      const num = amount === undefined || amount === null || amount === '' ? null : Number(amount);
      out.push({
        id: String(p.id),
        name: String(p.name || ''),
        price: num === null || !Number.isFinite(num) ? null : num,
        link: typeof p.link === 'string' ? p.link : '',
      });
    }
  }
  return out;
}

/** Product page URL: the API's link without its query string, else built from the id. */
export function migrosProductUrl(link: string, id: string): string {
  let l = String(link || '').trim();
  if (l) {
    l = l.split('?')[0].split('#')[0];
    if (l.startsWith('/')) l = 'https://www.migros.ch' + l;
    if (/^https:\/\/(www\.)?migros\.ch\//i.test(l)) return l;
  }
  return /^\d+$/.test(String(id || '')) ? 'https://www.migros.ch/de/product/' + id : '';
}

/** Lower-case word tokens with umlauts folded; receipt abbreviations keep their stem ("or." → "or"). */
export function nameTokens(s: string): string[] {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[éèê]/g, 'e').replace(/[àâ]/g, 'a')
    .split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/**
 * How well a (often abbreviated) receipt name matches a product name, 0..1:
 * the share of receipt words that equal, or are a prefix of, some product word.
 * "Bio Kürbis or. Knirps" vs "Bio Kürbis Oranger Knirps" → 1.
 */
export function nameScore(receiptName: string, productName: string): number {
  const r = nameTokens(receiptName).filter((t) => !/^\d+$/.test(t) || t.length > 1);
  const p = nameTokens(productName);
  if (!r.length || !p.length) return 0;
  let hit = 0;
  for (const t of r) {
    if (p.some((w) => w === t || (t.length >= 2 && w.startsWith(t)) || (w.length >= 3 && t.startsWith(w)))) hit++;
  }
  return hit / r.length;
}

/**
 * Pair receipt lines with products one-to-one (a product is used at most once).
 * Pass 1, price: a product whose price equals the line total or unit price
 * (±0.005); several candidates → best name score. Pass 2, name: remaining lines
 * against remaining products by nameScore ≥ 0.5 (weighed items have price null).
 */
export function pairReceiptLines(lines: ReceiptLine[], products: FlatProduct[]): PairedLine[] {
  const used = new Set<number>();
  const out: PairedLine[] = lines.map((l) => ({ ...l, id: '', u: '', by: '' }));
  const eq = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 0.005;
  for (const line of out) {
    const cands: number[] = [];
    products.forEach((p, i) => {
      if (!used.has(i) && (eq(p.price, line.total) || eq(p.price, line.unit))) cands.push(i);
    });
    if (!cands.length) continue;
    let best = cands[0];
    let bestScore = -1;
    for (const i of cands) {
      const s = nameScore(line.n, products[i].name);
      if (s > bestScore) { best = i; bestScore = s; }
    }
    // Same price but a clearly different name is a coincidence, not a match.
    if (cands.length > 1 && bestScore === 0) continue;
    used.add(best);
    line.id = products[best].id;
    line.u = migrosProductUrl(products[best].link, products[best].id);
    line.by = 'price';
  }
  for (const line of out) {
    if (line.id) continue;
    let best = -1;
    let bestScore = 0.5 - 1e-9;
    products.forEach((p, i) => {
      if (used.has(i)) return;
      const s = nameScore(line.n, p.name);
      if (s > bestScore) { best = i; bestScore = s; }
    });
    if (best < 0) continue;
    used.add(best);
    line.id = products[best].id;
    line.u = migrosProductUrl(products[best].link, products[best].id);
    line.by = 'name';
  }
  return out;
}
