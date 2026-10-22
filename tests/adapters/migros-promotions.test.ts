import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MigrosAdapter } from '../../src/adapters/migros/index.js';
import { fetchAllPromoItems, textMatches } from '../../src/adapters/migros/promotions.js';

const chicco = () => Object.values(JSON.parse(
  readFileSync('tests/fixtures/migros/chicco-1kg-min-pieces.json', 'utf8'),
))[0] as any;

const plain = (uid: number, brand: string, name: string) => ({
  uid,
  migrosId: `${uid}000`,
  name,
  title: `${brand} · ${name}`,
  offer: { quantity: '500g', price: { effectiveValue: 5, advertisedValue: 5 } },
  productInformation: { mainInformation: { brand: { name: brand } } },
});

/** 130 promo items; uid 1105 is the Chicco 1kg deal. Search finds Chicco products. */
function fakeApi(opts: { chiccoInList: boolean }) {
  const calls: { promo: Array<{ from: number; until: number }> } = { promo: [] };
  const list = Array.from({ length: 130 }, (_, i) => ({ id: 1000 + i, type: 'PRODUCT' }));
  const byUid = (u: string) => {
    if (u === '1105' && opts.chiccoInList) return { ...chicco(), uid: 1105 };
    if (u === '100001926') return chicco();
    if (u === '100002662') return plain(100002662, "Chicco D'Oro", 'Bohnenkaffee');
    return plain(Number(u), 'Migros', `Artikel ${u}`);
  };
  const api = {
    account: { oauth2: { loginGuestToken: async () => {} } },
    products: {
      productDisplay: {
        getProductPromotionSearch: async (o: any) => {
          calls.promo.push({ from: o.from, until: o.until });
          return { items: list.slice(o.from, o.until), numberOfItems: list.length, startDate: '2026-10-22', endDate: '2026-10-28' };
        },
        getProductDetails: async (o: any) =>
          Object.fromEntries((o.uids as string[]).map((u, i) => [String(i), byUid(u)])),
      },
      productSearch: {
        searchProduct: async () => ({ productIds: [100001926, 100002662] }),
      },
    },
  };
  const adapter = new MigrosAdapter();
  (adapter as any).api = api;
  return { adapter, calls };
}

describe('textMatches', () => {
  it('ignores case, accents and apostrophes', () => {
    expect(textMatches("Chicco d'Oro", "Chicco D'Oro Tradition · Bohnenkaffee")).toBe(true);
    expect(textMatches('cafe royal', 'Café Royal Lungo')).toBe(true);
  });
  it('needs every word', () => {
    expect(textMatches("Chicco d'Oro", "Moretti Baffo d'Oro")).toBe(false);
  });
});

describe('fetchAllPromoItems', () => {
  it('stops at numberOfItems', async () => {
    const pages: number[] = [];
    const r = await fetchAllPromoItems(async (from) => {
      pages.push(from);
      return { items: Array.from({ length: Math.min(100, 250 - from) }, (_, i) => ({ id: from + i })), numberOfItems: 250 };
    });
    expect(r.items).toHaveLength(250);
    expect(pages).toEqual([0, 100, 200]);
  });
});

describe('Migros getPromotions', () => {
  it('reads past the first 100 items', async () => {
    const { adapter, calls } = fakeApi({ chiccoInList: true });
    const r = await adapter.getPromotions({});
    expect(r.ok && r.data).toHaveLength(130);
    expect(calls.promo.map((c) => c.from)).toEqual([0, 100]);
  });

  it('filters by keyword and keeps the quantity deal', async () => {
    const { adapter } = fakeApi({ chiccoInList: true });
    const r = await adapter.getPromotions({ query: "Chicco d'Oro" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    expect(r.data[0].brand).toBe("Chicco D'Oro");
    expect(r.data[0].description).toBe('40% ab 2 Stück: CHF 11.94 pro Stück statt 19.90');
    expect(r.data[0].validUntil).toBe('2026-10-28');
  });

  it('falls back to search hits that carry a promotion', async () => {
    const { adapter } = fakeApi({ chiccoInList: false });
    const r = await adapter.getPromotions({ query: "Chicco d'Oro" });
    expect(r.ok && r.data.map((p) => p.productId)).toEqual(['107112500000']);
  });
});

describe('Migros region', () => {
  it('sends the Zürich region by default', async () => {
    const seen: any[] = [];
    const adapter = new MigrosAdapter();
    (adapter as any).api = {
      account: { oauth2: { loginGuestToken: async () => {} } },
      products: {
        productSearch: { searchProduct: async (o: any) => { seen.push(o); return { productIds: [1] }; } },
        productDisplay: { getProductDetails: async (o: any) => { seen.push(o); return {}; } },
      },
    };
    await adapter.searchProducts({ query: 'milch' });
    expect(seen[0].regionId).toBe('2');
    expect(seen[1].region).toBe('2');
  });
});
