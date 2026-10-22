// Helpers for the Migros weekly promotion list.
//
// Facts from a real capture (2026-10-22):
//   - promotion/search returns at most 100 items per request and reports the
//     full count in numberOfItems (1150 that week), so it must be paged.
//   - It ignores free-text queries; keyword filtering has to happen here.
//   - Items are {id, type}; type "PRODUCT" ids are catalogue uids.
import type { NormalizedProduct, NormalizedPromotion } from '../types.js';

export const PROMO_PAGE_SIZE = 100;
/** Safety stop in case numberOfItems is ever wrong. */
export const PROMO_MAX_ITEMS = 3000;
/** uids per product-detail request. */
export const DETAIL_BATCH_SIZE = 100;

export interface PromoItem { id: number | string; type?: string }
export interface PromoPage { items?: PromoItem[]; numberOfItems?: number; startDate?: string; endDate?: string }

/** Fetches every page of the promotion list via `fetchPage(from, until)`. */
export async function fetchAllPromoItems(
  fetchPage: (from: number, until: number) => Promise<PromoPage>,
): Promise<{ items: PromoItem[]; startDate?: string; endDate?: string }> {
  const items: PromoItem[] = [];
  let startDate: string | undefined;
  let endDate: string | undefined;
  let from = 0;
  let total = Infinity;
  while (from < total && from < PROMO_MAX_ITEMS) {
    const page = await fetchPage(from, from + PROMO_PAGE_SIZE);
    const batch = page.items ?? [];
    total = page.numberOfItems ?? 0;
    startDate = startDate ?? page.startDate;
    endDate = endDate ?? page.endDate;
    if (batch.length === 0) break;
    items.push(...batch);
    from += PROMO_PAGE_SIZE;
  }
  return { items, startDate, endDate };
}

/** Lowercase, strip accents and apostrophes, collapse to single-space words. */
function simplify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when every word of `query` occurs in `text` ("chicco doro" ~ "Chicco D'Oro"). */
export function textMatches(query: string, text: string): boolean {
  const words = simplify(query).split(' ').filter(Boolean);
  const haystack = ` ${simplify(text)} `;
  return words.every((w) => haystack.includes(w));
}

/** Text used for keyword matching: Migros `name` alone is often just "Bohnenkaffee". */
export function matchText(p: NormalizedProduct): string {
  const title = (p.raw as any)?.title ?? '';
  return `${p.brand ?? ''} ${title} ${p.name}`;
}

export function productToPromotion(p: NormalizedProduct, startDate?: string, endDate?: string): NormalizedPromotion {
  const range = (p.raw as any)?.offer?.promotionDateRange as { startDate?: string; endDate?: string } | undefined;
  return {
    chain: 'migros',
    productId: p.id,
    productName: p.name,
    brand: p.brand,
    imageUrl: p.imageUrl,
    size: p.size,
    unitPrice: p.unitPrice,
    price: p.price,
    validFrom: range?.startDate ?? startDate,
    validUntil: range?.endDate ?? p.promotion?.endsAt ?? endDate,
    description: p.promotion?.description,
  };
}
