// Builds the JavaScript the fridge-book import runs inside the user's own,
// already-logged-in account.migros.ch tab (via Claude in Chrome's javascript_tool).
// The script only reads the user's receipts through the same endpoints the
// receipts page uses, parses and pairs them in the page, and returns item lines
// only — never payment, card or Cumulus lines. It does not log in, click or write.
import {
  parseMigrosReceiptText, flattenMigrosProducts, migrosProductUrl,
  nameTokens, nameScore, pairReceiptLines,
} from './receipt.js';

export interface MigrosScriptOptions {
  /** YYYY-MM-DD, inclusive. Used when rids is empty. */
  dateFrom?: string;
  /** YYYY-MM-DD, inclusive. */
  dateTo?: string;
  /** Receipt transaction ids to fetch directly (e.g. to backfill product ids). */
  rids?: string[];
  /** Receipt ids already imported; they are listed as skipped, not fetched. */
  skip?: string[];
}

const EMBEDDED = [
  parseMigrosReceiptText, flattenMigrosProducts, migrosProductUrl,
  nameTokens, nameScore, pairReceiptLines,
];

export function buildMigrosReceiptScript(opts: MigrosScriptOptions): string {
  const cfg = JSON.stringify({
    dateFrom: opts.dateFrom ?? '',
    dateTo: opts.dateTo ?? '',
    rids: (opts.rids ?? []).map(String),
    skip: (opts.skip ?? []).map(String),
  });
  return `(async () => {
${EMBEDDED.map((f) => f.toString()).join('\n')}
const cfg = ${cfg};
const out = { ok: true, loggedIn: true, receipts: [], skipped: [], errors: [] };
if (!/(^|\\.)account\\.migros\\.ch$/.test(location.hostname)) {
  return JSON.stringify({ ok: false, loggedIn: !/login\\.migros\\.ch$/.test(location.hostname), receipts: [], skipped: [], errors: ['not on account.migros.ch: ' + location.hostname] });
}
const get = async (path, kind) => {
  const r = await fetch(path, { credentials: 'include', headers: { accept: kind === 'json' ? 'application/json' : 'text/html' } });
  if (r.status === 401 || r.status === 403 || /login\\.migros\\.ch/.test(r.url)) { out.loggedIn = false; throw new Error('not logged in (' + r.status + ')'); }
  if (!r.ok) throw new Error(path.split('?')[0] + ' HTTP ' + r.status);
  return kind === 'json' ? r.json() : r.text();
};
let list = [];
try {
  if (cfg.rids.length) list = cfg.rids.map((id) => ({ transactionId: id }));
  else {
    const q = new URLSearchParams({ dateFrom: cfg.dateFrom, dateTo: cfg.dateTo });
    const res = await get('/ma/api/user/receipt?' + q, 'json');
    list = Array.isArray(res) ? res : (res && Array.isArray(res.receipts) ? res.receipts : []);
  }
} catch (e) {
  out.ok = false; out.errors.push(String(e && e.message || e));
  return JSON.stringify(out);
}
const skip = new Set(cfg.skip);
for (const r of list) {
  const rid = String(r.transactionId || '');
  if (!rid) continue;
  if (skip.has(rid)) { out.skipped.push(rid); continue; }
  if (r.hasDetail === false) { out.skipped.push(rid); continue; }
  try {
    const html = await get('/ma/api/user/receipt/' + encodeURIComponent(rid) + '?type=HTML', 'text');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lines = parseMigrosReceiptText(doc.body ? doc.body.innerText || doc.body.textContent || '' : '');
    let products = [];
    try { products = flattenMigrosProducts(await get('/ma/api/user/receipt/' + encodeURIComponent(rid) + '/product', 'json')); }
    catch (e) { if (!out.loggedIn) throw e; out.errors.push(rid + ': product list ' + (e && e.message || e)); }
    const items = pairReceiptLines(lines, products).map((l) => ({
      n: l.n, qty: l.qty, weighed: l.weighed, unit: l.unit, disc: l.disc, p: l.total, id: l.id, u: l.u, by: l.by,
    }));
    const date = String(r.transactionDate || '').slice(0, 10) || (/^(\\d{4})(\\d{2})(\\d{2})_/.exec(rid) || []).slice(1).join('-');
    out.receipts.push({ rid, date, store: String(r.storeName || ''), total: r.total ?? null,
      items, matched: items.filter((i) => i.id).length, products: products.length });
  } catch (e) {
    out.errors.push(rid + ': ' + (e && e.message || e));
    if (!out.loggedIn) { out.ok = false; break; }
  }
}
if (out.errors.length && !out.receipts.length && list.length) out.ok = false;
return JSON.stringify(out);
})()`;
}
