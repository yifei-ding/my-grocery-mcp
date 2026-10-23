// MigrosAdapter — wraps migros-api-wrapper with guest-token auth.
//
// Key API shape divergences from plan:
//   - Wrapper exports { MigrosAPI } (named), not a default object.
//   - Auth: must call api.account.oauth2.loginGuestToken() before any product call.
//   - searchProduct returns { productIds: number[], ... } — NOT product objects.
//   - getProductDetails expects { uids: string[], ... } and returns {"0":{...}, "1":{...}}.
//   - searchStores returns a plain array (not wrapped).
//   - getProductPromotionSearch returns { items: [{id, type},...], numberOfItems, startDate, endDate }.
// Note: migros-api-wrapper does its own fetching internally and is not wrapped
// with httpJson — the wrapper manages auth tokens and request lifecycle.
// Caching, retry, and rate-limiting for Migros must be handled at the adapter
// level or deferred to a future wrapper replacement.
import { MigrosAPI } from 'migros-api-wrapper';
import type {
  StoreAdapter, AdapterResult, AdapterError,
  NormalizedProduct, NormalizedStore, NormalizedPromotion, StockResult,
  SearchQuery, StoreQuery, PromotionQuery, GeoPoint,
} from '../types.js';
import { logger } from '../../util/log.js';
import { normalizeProduct, normalizeStore, normalizePromotion } from './normalize.js';
import { ok, err } from '../../util/adapter-result.js';
import { MigrosProductDetailsResponseSchema } from './schemas.js';
import { haversineKm } from '../../util/haversine.js';
import {
  fetchAllPromoItems, textMatches, matchText, productToPromotion, DETAIL_BATCH_SIZE, type PromoPage,
} from './promotions.js';

// Prices for regional products (fresh produce etc.) only come back for a
// concrete Migros cooperative region; the wrapper's default "national" leaves
// them empty. "2" is the Zürich cooperative. Set MIGROS_REGION to override.
export const MIGROS_REGION: string = process.env.MIGROS_REGION || '2';

function classifyError(e: unknown): AdapterError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|403|token|auth/i.test(msg)) return { code: 'auth_expired', reason: msg };
  if (/429|rate limit/i.test(msg))     return { code: 'rate_limited' };
  if (/404/.test(msg))                 return { code: 'not_found' };
  return { code: 'unavailable', reason: msg };
}

export class MigrosAdapter implements StoreAdapter {
  readonly chain = 'migros' as const;
  readonly capabilities = {
    productSearch: true,
    productDetail: true,
    storeSearch: true,
    promotions: true,
    perStoreStock: true,
    perStorePricing: false,
  };

  private api: MigrosAPI;
  private authPromise: Promise<void> | null = null;

  constructor() {
    this.api = new MigrosAPI();
  }

  /** Lazily obtains a guest token on first call; coalesces concurrent callers. */
  private ensureAuth(): Promise<void> {
    if (!this.authPromise) {
      this.authPromise = (async () => {
        await this.api.account.oauth2.loginGuestToken();
      })().catch((e) => {
        this.authPromise = null;
        throw e;
      });
    }
    return this.authPromise;
  }

  /** Force re-auth on the next ensureAuth() call (e.g. after a 401 mid-session). */
  private invalidateAuth(): void {
    this.authPromise = null;
  }

  /**
   * Wraps an API call with one retry on auth_expired: if the call surfaces a 401/403,
   * we drop the cached guest token, re-auth, and retry once. Real expired-token
   * recoveries pass through transparently; programmer errors still bubble up.
   */
  private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureAuth();
    try {
      return await fn();
    } catch (e) {
      const err = classifyError(e);
      if (err.code !== 'auth_expired') throw e;
      this.invalidateAuth();
      await this.ensureAuth();
      return fn();
    }
  }

  async searchProducts(q: SearchQuery): Promise<AdapterResult<NormalizedProduct[]>> {
    try {
      const r = await this.withAuthRetry(() => this.api.products.productSearch.searchProduct({
        query: q.query,
        language: q.language ?? 'de',
        regionId: MIGROS_REGION,
      } as any));
      // r = { productIds: number[], numberOfProducts: number, ... }
      const productIds: number[] = (r as any).productIds ?? [];
      if (productIds.length === 0) return ok([]);
      const offset = q.offset ?? 0;
      const uids = productIds.slice(offset, offset + (q.limit ?? 20)).map(String);
      const det = await this.withAuthRetry(() => this.api.products.productDisplay.getProductDetails({ uids, language: q.language ?? 'de', region: MIGROS_REGION } as any));
      // det = {"0": product, "1": product, ...}
      const parsed = MigrosProductDetailsResponseSchema.safeParse(det);
      if (!parsed.success) {
        return err({ code: 'schema_mismatch', sample: JSON.stringify(det).slice(0, 500) } as AdapterError);
      }
      const products = (Array.isArray(parsed.data) ? parsed.data : Object.values(parsed.data)) as any[];
      return ok(products.map(normalizeProduct));
    } catch (e) {
      return err(classifyError(e));
    }
  }

  /** getProductDetails only accepts uids (9 digits) — never a migrosId. */
  private async fetchByUid(uid: string): Promise<any | null> {
    const r = await this.withAuthRetry(() => this.api.products.productDisplay.getProductDetails({
      uids: [uid], language: 'de', region: MIGROS_REGION,
    } as any));
    const products = Object.values(r as Record<string, unknown>);
    return products[0] ?? null;
  }

  /**
   * id passed to getProduct is often a migrosId (12 digits) — it's the `id`
   * field normalize.ts exposes on search results, and what the Migros
   * receipt API (/ma/api/user/receipt/<id>/product) hands back — not a uid.
   * getProductDetails silently returns [] for a uid that doesn't exist, so
   * resolve it by searching for the id as free text, which reliably matches
   * exactly the one product carrying it, and yields its uid. Some products
   * only turn up under the "national" region rather than the adapter's
   * configured MIGROS_REGION, so retry there before giving up.
   */
  private async resolveMigrosId(migrosId: string): Promise<any | null> {
    const regions = [...new Set([MIGROS_REGION, 'national'])];
    for (const regionId of regions) {
      const search = await this.withAuthRetry(() => this.api.products.productSearch.searchProduct({
        query: migrosId, language: 'de', regionId,
      } as any));
      const uid = (search as any)?.productIds?.[0];
      if (uid !== undefined) return this.fetchByUid(String(uid));
    }
    return null;
  }

  async getProduct(id: string): Promise<AdapterResult<NormalizedProduct | null>> {
    try {
      const product = (await this.fetchByUid(id)) ?? (await this.resolveMigrosId(id));
      return ok(product ? normalizeProduct(product) : null);
    } catch (e) {
      return err(classifyError(e));
    }
  }

  async searchStores(q: StoreQuery): Promise<AdapterResult<NormalizedStore[]>> {
    try {
      // searchStores does NOT require auth token per source — but we ensureAuth + retry anyway for consistency
      const query = q.cityHint ?? '';
      const r: any = await this.withAuthRetry(() => this.api.stores.searchStores({ query } as any));
      // r is a plain array of store objects
      const list = ((r as any).stores ?? r) as any[];
      const radius = q.radiusKm ?? 5;
      const normalized = list.map(normalizeStore).filter(
        (s) => haversineKm(q.near, s.location) <= radius,
      );
      return ok(normalized);
    } catch (e) {
      return err(classifyError(e));
    }
  }

  async getPromotions(q: PromotionQuery): Promise<AdapterResult<NormalizedPromotion[]>> {
    try {
      const language = q.language ?? 'de';
      const { items, startDate, endDate } = await fetchAllPromoItems((from, until) =>
        this.withAuthRetry(() => this.api.products.productDisplay.getProductPromotionSearch({
          language, from, until, region: MIGROS_REGION,
        } as any)) as Promise<PromoPage>,
      );

      // Only PRODUCT items name a single product; other types (seen in older
      // captures as GROUP_PROMOTION) carry no product id and are skipped.
      const uids = [...new Set(items.filter((it) => !it.type || it.type === 'PRODUCT').map((it) => String(it.id)))];

      const products: NormalizedProduct[] = [];
      for (let i = 0; i < uids.length; i += DETAIL_BATCH_SIZE) {
        const det: any = await this.withAuthRetry(() => this.api.products.productDisplay.getProductDetails({
          uids: uids.slice(i, i + DETAIL_BATCH_SIZE), language, region: MIGROS_REGION,
        } as any));
        const raws = (Array.isArray(det) ? det : Object.values(det ?? {})) as any[];
        products.push(...raws.map(normalizeProduct));
      }

      let promos = products.map((p) => productToPromotion(p, startDate, endDate));

      const query = q.query?.trim();
      if (query) {
        const kept = new Set(products.filter((p) => textMatches(query, matchText(p))).map((p) => p.id));
        promos = promos.filter((p) => p.productId !== undefined && kept.has(p.productId));
        // Cheap second source for keyword queries: a regular search returns
        // promotion data too, and catches deals the list does not expose.
        const found = await this.searchProducts({ query, language, limit: 40 });
        if (found.ok) {
          for (const p of found.data) {
            if (!p.promotion || kept.has(p.id) || !textMatches(query, matchText(p))) continue;
            kept.add(p.id);
            promos.push(productToPromotion(p, startDate, endDate));
          }
        }
      }

      if (q.endingWithinDays !== undefined) {
        const cutoff = Date.now() + q.endingWithinDays * 24 * 3600 * 1000;
        promos = promos.filter((p) => p.validUntil && Date.parse(p.validUntil) <= cutoff);
      }
      return ok(promos);
    } catch (e) {
      return err(classifyError(e));
    }
  }

  async findStoresWithStock(productId: string, near?: GeoPoint): Promise<AdapterResult<StockResult[]>> {
    try {
      const storesRes = await this.searchStores({ near: near ?? { lat: 47.376, lng: 8.541 }, radiusKm: 5 });
      if (!storesRes.ok) return storesRes;
      const checks = await Promise.all(
        storesRes.data.map(async (store) => {
          try {
            const r = await this.withAuthRetry(() => this.api.products.productStock.getProductSupply({ productId, storeId: store.id } as any));
            return { store, inStock: !!((r as any).available ?? (r as any).inStock), quantity: (r as any).quantity };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.debug(`[migros] stock check failed for store ${store.id}: ${msg}`);
            return { store, inStock: false };
          }
        }),
      );
      return ok(checks);
    } catch (e) {
      return err(classifyError(e));
    }
  }
}
