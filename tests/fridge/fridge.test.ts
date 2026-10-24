import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import {
  parseMigrosReceiptText, parseCoopReceiptText, flattenMigrosProducts,
  migrosProductUrl, nameScore, pairReceiptLines,
} from '../../src/fridge/receipt.js';
import { chainOf, slugOf, nutriKey, addDaysIso } from '../../src/fridge/fields.js';
import { buildMigrosReceiptScript } from '../../src/fridge/browser-script.js';
import { fridgeItemFieldsHandler, migrosReceiptScriptSchema } from '../../src/tools/fridge.js';

// Shape of a Migros receipt's innerText (names/prices from a real 2026-10 receipt;
// header/footer lines are representative and must never be returned).
const MIGROS_TEXT = `Genossenschaft Migros Zürich
M Kreuzplatz
Artikelbezeichnung                Menge   Preis  Aktion   Total  Z
Aptamil Pron.1 Maxi                   1   34.95           34.95  1
Bio Schweinshals                  0.594   29.95           17.80  1
Bio Kürbis or. Knirps             2.122    4.75           10.10  1
Chicco d'Oro Bohnen                   2   19.90   -15.92  23.88  1
Spinat                                1    2.95            2.95  1
N°13 Mehrzweckbeutel                  1    0.30            0.30  2
Zwischentotal                                            89.98
Cumulus-Nummer 2099 9999 9999 9
Visa ************1234                                    89.98
`;

const PRODUCTS_GROUPED = {
  'Baby': [{ id: 521000100000, name: 'Aptamil Pronutra 1 Maxi', brand: 'Aptamil', price: { amount: 34.95 }, link: '/de/product/521000100000?ref=x', labels: [] }],
  'Fleisch': [{ id: '220632500020', name: 'Bio Schweinshals', price: null, link: 'https://www.migros.ch/de/product/220632500020' }],
  'Gemüse': [
    { id: '273781001000', name: 'Bio Kürbis Oranger Knirps', price: null },
    { id: '271207909300', name: 'Spinat', price: { amount: 2.95 }, link: '' },
  ],
  'Kaffee': [{ id: '107112500000', name: "Chicco d'Oro Bohnen", price: { amount: 11.94 } }],
  'Haushalt': [{ id: '999', name: 'Mehrzweckbeutel 2l', price: { amount: 0.3 } }],
};

describe('parseMigrosReceiptText', () => {
  const lines = parseMigrosReceiptText(MIGROS_TEXT);
  it('returns only item lines between header and Zwischentotal', () => {
    expect(lines.map((l) => l.n)).toEqual([
      'Aptamil Pron.1 Maxi', 'Bio Schweinshals', 'Bio Kürbis or. Knirps',
      "Chicco d'Oro Bohnen", 'Spinat', 'N°13 Mehrzweckbeutel',
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Cumulus|Visa|1234/);
  });
  it('reads qty, weight flag, unit, discount and total', () => {
    expect(lines[1]).toEqual({ n: 'Bio Schweinshals', qty: 0.594, weighed: true, unit: 29.95, disc: null, total: 17.8 });
    expect(lines[3]).toMatchObject({ qty: 2, weighed: false, unit: 19.9, disc: -15.92, total: 23.88 });
  });
  it('returns [] without the header', () => {
    expect(parseMigrosReceiptText('nothing here')).toEqual([]);
  });
});

describe('parseCoopReceiptText', () => {
  it('parses lines between Artikel and Total CHF', () => {
    const text = `Coop Zürich Stadelhofen
Artikel                     Menge  Preis  Aktion  Total
Naturaplan Bio Tofu             2   3.20          6.40  0
Bananen                     1.034   3.50   -0.70  2.92  0
Total CHF                                        9.32
`;
    const l = parseCoopReceiptText(text);
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ n: 'Naturaplan Bio Tofu', qty: 2, total: 6.4, disc: null });
    expect(l[1]).toMatchObject({ n: 'Bananen', weighed: true, disc: -0.7, total: 2.92 });
  });
});

describe('products and pairing', () => {
  const products = flattenMigrosProducts(PRODUCTS_GROUPED);
  it('flattens grouped products to id/name/price/link', () => {
    expect(products).toHaveLength(6);
    expect(products[0]).toEqual({ id: '521000100000', name: 'Aptamil Pronutra 1 Maxi', price: 34.95, link: '/de/product/521000100000?ref=x' });
    expect(products[1].price).toBeNull();
  });
  it('builds product urls', () => {
    expect(migrosProductUrl('/de/product/1?x=1', '1')).toBe('https://www.migros.ch/de/product/1');
    expect(migrosProductUrl('', '107112500000')).toBe('https://www.migros.ch/de/product/107112500000');
    expect(migrosProductUrl('https://evil.example/x', '5')).toBe('https://www.migros.ch/de/product/5');
  });
  it('scores abbreviated receipt names', () => {
    expect(nameScore('Bio Kürbis or. Knirps', 'Bio Kürbis Oranger Knirps')).toBe(1);
    expect(nameScore('Spinat', 'Bio Kürbis Oranger Knirps')).toBe(0);
  });
  it('pairs by price first, then by name, one-to-one', () => {
    const paired = pairReceiptLines(parseMigrosReceiptText(MIGROS_TEXT), products);
    const by = Object.fromEntries(paired.map((p) => [p.n, [p.id, p.by]]));
    expect(by['Aptamil Pron.1 Maxi']).toEqual(['521000100000', 'price']);
    expect(by['Spinat']).toEqual(['271207909300', 'price']);
    expect(by['Bio Schweinshals']).toEqual(['220632500020', 'name']);
    expect(by['Bio Kürbis or. Knirps']).toEqual(['273781001000', 'name']);
    expect(by["Chicco d'Oro Bohnen"]).toEqual(['107112500000', 'name']);
    expect(by['N°13 Mehrzweckbeutel']).toEqual(['999', 'price']);
    expect(new Set(paired.map((p) => p.id)).size).toBe(paired.length);
    expect(paired[0].u).toBe('https://www.migros.ch/de/product/521000100000');
  });
  it('leaves unmatched lines empty', () => {
    const p = pairReceiptLines([{ n: 'Something else', qty: 1, weighed: false, unit: 9.99, disc: null, total: 9.99 }], products);
    expect(p[0]).toMatchObject({ id: '', u: '', by: '' });
  });
});

describe('fields (must match the App)', () => {
  it('chainOf', () => {
    expect(chainOf('M Forch-Burgwies')).toBe('migros');
    expect(chainOf('Migros Kreuzplatz')).toBe('migros');
    expect(chainOf('Coop Zürich Stadelhofen')).toBe('coop');
    expect(chainOf('Lidl')).toBe('other');
  });
  it('slug and key match the App example', () => {
    expect(nutriKey('M Forch-Burgwies', 'MBud ASC Crevetten roh')).toBe('migros:mbud-asc-crevetten-roh');
    expect(slugOf('Äpfel Kanzi')).toBe('aepfel-kanzi');
    expect(slugOf("Chicco d'Oro Bohnen")).toBe('chicco-d-oro-bohnen');
    expect(nutriKey('Lidl', '豆腐', 'Tofu')).toBe('other:tofu');
    expect(nutriKey('Lidl', '', '')).toBe('');
  });
  it('App slug function gives the same result', () => {
    // Copied verbatim from the App's page script.
    const appSlug = (s: string) => String(s || '').toLowerCase().replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss').replace(/[éèê]/g,'e').replace(/[àâ]/g,'a')
      .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 100);
    for (const s of ['Bio Kürbis or. Knirps', 'Café crème 500g', 'N°13 Mehrzweckbeutel', '  à la carte  ', 'x'.repeat(150)]) {
      expect(slugOf(s)).toBe(appSlug(s));
    }
  });
  it('expires from kind or shelfDays', async () => {
    const out = await fridgeItemFieldsHandler({} as any, { items: [
      { store: 'M Kreuzplatz', name: 'Bio Schweinshals', bought: '2026-10-30', kind: '生肉禽鱼' },
      { store: 'M Kreuzplatz', name: 'Spinat', bought: '2026-12-30', shelfDays: 4 },
      { store: 'M Kreuzplatz', name: 'X' },
    ] });
    expect(out[0]).toMatchObject({ key: 'migros:bio-schweinshals', shelfDays: 2, expires: '2026-11-01' });
    expect(out[1].expires).toBe('2027-01-03');
    expect(out[2]).toMatchObject({ shelfDays: null, expires: null });
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('migros receipt browser script', () => {
  function runScript(script: string, opts: { host?: string; loggedIn?: boolean } = {}) {
    const calls: string[] = [];
    const fetch = async (path: string) => {
      calls.push(path);
      if (opts.loggedIn === false) return { ok: false, status: 401, url: path, json: async () => ({}), text: async () => '' };
      if (path.startsWith('/ma/api/user/receipt?')) {
        return { ok: true, status: 200, url: path, json: async () => [
          { transactionId: '20261023_164938_0150009_003_441', transactionDate: '2026-10-23T16:49:38', storeName: 'M Kreuzplatz', total: 89.98, hasDetail: true },
          { transactionId: 'old', transactionDate: '2026-10-20', storeName: 'M Kreuzplatz', hasDetail: true },
        ] };
      }
      if (path.endsWith('/product')) return { ok: true, status: 200, url: path, json: async () => PRODUCTS_GROUPED };
      return { ok: true, status: 200, url: path, text: async () => MIGROS_TEXT };
    };
    const ctx = {
      fetch, URLSearchParams,
      location: { hostname: opts.host ?? 'account.migros.ch' },
      DOMParser: class { parseFromString(s: string) { return { body: { innerText: s } }; } },
    };
    const p = vm.runInNewContext(script, ctx) as Promise<string>;
    return p.then((s) => ({ out: JSON.parse(s), calls }));
  }

  it('lists, parses and pairs, skipping imported receipts', async () => {
    const { out, calls } = await runScript(buildMigrosReceiptScript({ dateFrom: '2026-10-17', dateTo: '2026-10-24', skip: ['old'] }));
    expect(out.ok).toBe(true);
    expect(out.skipped).toEqual(['old']);
    expect(out.receipts).toHaveLength(1);
    const r = out.receipts[0];
    expect(r).toMatchObject({ rid: '20261023_164938_0150009_003_441', date: '2026-10-23', store: 'M Kreuzplatz', matched: 6, products: 6 });
    expect(r.items[1]).toMatchObject({ n: 'Bio Schweinshals', qty: 0.594, weighed: true, p: 17.8, id: '220632500020' });
    expect(JSON.stringify(out)).not.toMatch(/Cumulus|Visa|1234/);
    expect(calls[0]).toBe('/ma/api/user/receipt?dateFrom=2026-10-17&dateTo=2026-10-24');
    expect(calls.some((c) => c.includes('old'))).toBe(false);
  });

  it('fetches given rids directly', async () => {
    const { out, calls } = await runScript(buildMigrosReceiptScript({ rids: ['20261023_164938_0150009_003_441'] }));
    expect(calls.some((c) => c.startsWith('/ma/api/user/receipt?'))).toBe(false);
    expect(out.receipts[0].date).toBe('2026-10-23');
  });

  it('reports logged-out and wrong host', async () => {
    const a = await runScript(buildMigrosReceiptScript({ dateFrom: '2026-10-17', dateTo: '2026-10-24' }), { loggedIn: false });
    expect(a.out).toMatchObject({ ok: false, loggedIn: false });
    const b = await runScript(buildMigrosReceiptScript({ dateFrom: '2026-10-17', dateTo: '2026-10-24' }), { host: 'login.migros.ch' });
    expect(b.out).toMatchObject({ ok: false, loggedIn: false });
  });

  it('schema requires a date range or rids', () => {
    expect(migrosReceiptScriptSchema.safeParse({}).success).toBe(false);
    expect(migrosReceiptScriptSchema.safeParse({ rids: ['a'] }).success).toBe(true);
  });
});
