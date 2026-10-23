import { z } from 'zod';

// Covers the fields that normalize.ts reads from getProductDetails responses.
// Uses passthrough() so unknown fields don't cause validation failures.
export const MigrosProductDetailSchema = z.object({
  uid: z.number().optional(),
  migrosId: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  versioning: z.string().optional(),
  offer: z.object({
    price: z.object({
      effectiveValue: z.number().optional(),
      advertisedValue: z.number().optional(),
      unitPrice: z.object({
        value: z.number().optional(),
        unit: z.string().optional(),
      }).optional(),
    }).optional(),
    quantity: z.string().optional(),
    isVariableWeight: z.boolean().optional(),
    promotion: z.object({
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      description: z.string().optional(),
    }).optional(),
  })
    // Keep undeclared offer fields (badges, promotionPrice, promotionDateRange).
    // zod drops unknown keys from nested objects by default, which removed all
    // promotion data from search results.
    .passthrough()
    .optional(),
  images: z.array(z.object({
    url: z.string().optional(),
    cdn: z.string().optional(),
  })).optional(),
  productInformation: z.object({
    mainInformation: z.object({
      brand: z.object({ name: z.string().optional() }).optional(),
      labels: z.array(z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        slug: z.string().optional(),
      })).optional(),
    })
      // Keep undeclared mainInformation fields (nutrientsInformation): zod
      // drops unknown keys from nested objects by default, which removed
      // the nutrition table from search_products results.
      .passthrough()
      .optional(),
  })
    // nutrientsInformation has been observed directly under productInformation
    // (sibling of mainInformation) on some product captures, and nested inside
    // mainInformation on others — passthrough here covers the sibling case.
    .passthrough()
    .optional(),
  breadcrumb: z.array(z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  })).optional(),
}).passthrough();

// The getProductDetails endpoint returns {"0": product, "1": product, ...}
// or an array. We validate each product entry individually.
export const MigrosProductDetailsResponseSchema = z.union([
  z.array(MigrosProductDetailSchema),
  z.record(z.string(), MigrosProductDetailSchema),
]);
