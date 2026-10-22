import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeProduct, readMinimumPieces } from '../../src/adapters/migros/normalize.js';

// Real product-detail response, Chicco d'Oro Tradition 1kg, captured 2026-10-22:
// badges PERCENTAGE_PROMOTION "40%" + MINIMUM_PIECES "Ab 2 Stück", promotionPrice 11.94.
const load = () => Object.values(JSON.parse(
  readFileSync('tests/fixtures/migros/chicco-1kg-min-pieces.json', 'utf8'),
))[0] as any;

describe('readMinimumPieces', () => {
  it('parses the piece count', () => {
    expect(readMinimumPieces([{ type: 'MINIMUM_PIECES', description: 'Ab 2 Stück' }])).toBe(2);
    expect(readMinimumPieces([{ type: 'MINIMUM_PIECES', description: 'Ab 3 Stück' }])).toBe(3);
  });
  it('returns 0 without the badge', () => {
    expect(readMinimumPieces([{ type: 'PERCENTAGE_PROMOTION', description: '40%' }])).toBe(0);
    expect(readMinimumPieces(undefined)).toBe(0);
  });
});

describe('Migros quantity deal', () => {
  it('prices one piece at the regular price and describes the deal', () => {
    const p = normalizeProduct(load());
    expect(p.price.current).toBe(19.9);
    expect(p.price.regular).toBeUndefined();
    expect(p.promotion?.endsAt).toBe('2026-10-28');
    expect(p.promotion?.description).toBe('40% ab 2 Stück: CHF 11.94 pro Stück statt 19.90');
  });

  it('keeps plain percentage promotions as before', () => {
    const raw = load();
    raw.offer.badges = raw.offer.badges.filter((b: any) => b.type !== 'MINIMUM_PIECES');
    const p = normalizeProduct(raw);
    expect(p.price.current).toBe(11.94);
    expect(p.price.regular).toBe(19.9);
    expect(p.promotion?.description).toBe('40%');
  });
});
