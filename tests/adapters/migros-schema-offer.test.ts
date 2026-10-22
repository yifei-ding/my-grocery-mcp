import { describe, it, expect } from 'vitest';
import { MigrosProductDetailsResponseSchema } from '../../src/adapters/migros/schemas.js';

describe('Migros detail schema', () => {
  it('keeps promotion fields inside offer', () => {
    const input = {
      '0': {
        uid: 1,
        offer: {
          price: { effectiveValue: 19.9 },
          promotionPrice: { effectiveValue: 11.94 },
          promotionDateRange: { startDate: '2026-10-22', endDate: '2026-10-28' },
          badges: [{ type: 'MINIMUM_PIECES', description: 'Ab 2 Stück' }],
        },
      },
    };
    const out: any = MigrosProductDetailsResponseSchema.parse(input);
    expect(out['0'].offer.promotionPrice.effectiveValue).toBe(11.94);
    expect(out['0'].offer.promotionDateRange.endDate).toBe('2026-10-28');
    expect(out['0'].offer.badges).toHaveLength(1);
  });
});
