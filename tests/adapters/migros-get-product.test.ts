import { describe, it, expect } from 'vitest';
import { MigrosAdapter } from '../../src/adapters/migros/index.js';

// Bug: get_product({chain:"migros", id:"<migrosId>"}) returned null for ids
// that search_products itself returns as `id` (the 12-digit migrosId), and
// for the ids the Migros receipt API (/ma/api/user/receipt/<id>/product)
// hands back — because getProductDetails only ever accepts a uid (9 digits),
// and silently returns [] for one that doesn't exist, rather than erroring.

const product = (uid: number, migrosId: string, name: string) => ({
  uid, migrosId, name,
  offer: { price: { effectiveValue: 1, advertisedValue: 1 } },
});

function fakeApi(opts: {
  byUid: Record<string, any>;
  searchByRegion: Record<string, Record<string, number[]>>; // query -> regionId -> productIds
}) {
  const calls: { search: any[]; detail: any[] } = { search: [], detail: [] };
  const api = {
    account: { oauth2: { loginGuestToken: async () => {} } },
    products: {
      productDisplay: {
        getProductDetails: async (o: any) => {
          calls.detail.push(o);
          const uid = (o.uids as string[])[0];
          const p = opts.byUid[uid];
          return p ? { '0': p } : [];
        },
      },
      productSearch: {
        searchProduct: async (o: any) => {
          calls.search.push(o);
          const productIds = opts.searchByRegion[o.query]?.[o.regionId] ?? [];
          return { productIds, numberOfProducts: productIds.length };
        },
      },
    },
  };
  const adapter = new MigrosAdapter();
  (adapter as any).api = api;
  return { adapter, calls };
}

describe('Migros getProduct', () => {
  it('fetches directly when id is already a uid (fast path, no search call)', async () => {
    const { adapter, calls } = fakeApi({
      byUid: { '100046265': product(100046265, '165055900000', 'Crevetten') },
      searchByRegion: {},
    });
    const r = await adapter.getProduct('100046265');
    expect(r.ok && r.data?.name).toBe('Crevetten');
    expect(calls.search).toHaveLength(0);
  });

  it('resolves a migrosId via search when the direct uid lookup is empty', async () => {
    const { adapter, calls } = fakeApi({
      byUid: { '100046265': product(100046265, '165055900000', 'Crevetten') },
      searchByRegion: { '165055900000': { '2': [100046265] } },
    });
    const r = await adapter.getProduct('165055900000');
    expect(r.ok && r.data?.name).toBe('Crevetten');
    // one failed uid lookup, then a search, then the real uid lookup
    expect(calls.detail).toHaveLength(2);
    expect(calls.search).toHaveLength(1);
    expect(calls.search[0].regionId).toBe('2');
  });

  it('falls back to the national region when the configured region has no match', async () => {
    const { adapter } = fakeApi({
      byUid: { '100128829': product(100128829, '273781001000', 'Kürbis') },
      searchByRegion: { '273781001000': { national: [100128829] } }, // absent under region '2'
    });
    const r = await adapter.getProduct('273781001000');
    expect(r.ok && r.data?.name).toBe('Kürbis');
  });

  it('returns null, not an error, when the id resolves nowhere', async () => {
    const { adapter } = fakeApi({ byUid: {}, searchByRegion: {} });
    const r = await adapter.getProduct('000000000000');
    expect(r).toEqual({ ok: true, data: null });
  });
});
