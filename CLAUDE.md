# my-grocery-mcp

Personal MCP server (stdio) for Swiss grocery search, prices and weekly promotions.
Forked from nicktcode/swissgroceries-mcp **v0.7.4 (MIT)**. Later upstream versions are
PolyForm Shield / AGPL: never copy code from upstream releases after v0.7.4 — reimplement.
Keep `LICENSE` (both copyright lines) intact.

Reply to the owner in Chinese; add English for core technical terms. Be concise.

## Commands

```bash
npm test          # vitest, offline, uses tests/fixtures
npm run build     # tsc -> dist/  (Claude Desktop runs dist/index.js)
npm run smoke     # live tests against real chain APIs (RUN_LIVE=1)
npm run dev       # tsx src/index.ts
```

A change only reaches Claude Desktop after `npm run build` **and** a full restart of
Claude Desktop (⌘Q, reopen). Config entry: `mcpServers.my-grocery` in
`~/Library/Application Support/Claude/claude_desktop_config.json`.

## Architecture (request flows top → bottom)

1. `src/index.ts` — MCP layer only: `buildRegistry()` registers adapters; `TOOLS` array
   (name, description, zod schema, handler); `CallTool` parses args with zod, runs the
   handler, returns JSON text. Tool descriptions are what the model reads — treat them as UX.
2. `src/tools/*.ts` — one file per tool: `xxxSchema` (zod, also becomes the JSON Schema)
   + `xxxHandler(registry, input)`. Fan out to adapters in parallel, merge results.
3. `src/services/` — only used by `plan_shopping`: `matcher.ts` (score candidates),
   `strategy.ts` (single_store / split_cart / absolute_cheapest), `planner.ts` (glue),
   `geocoding.ts` (ZIP/address → lat/lng).
4. `src/adapters/<chain>/` — one folder per chain: `index.ts` (adapter class, API calls,
   auth), `client.ts` (HTTP via `util/http.ts`), `schemas.ts` (zod validation),
   `normalize.ts` (raw JSON → `NormalizedProduct`), `tags.ts` (organic/vegan/… tags).
5. `src/adapters/types.ts` — the contract: `StoreAdapter`, `NormalizedProduct`,
   `NormalizedPromotion`, `AdapterCapabilities`, `AdapterResult`. New fields start here.
6. `src/util/` — `http.ts` (cache 5 min, retry, rate limit), `unit-price.ts`, `multipack.ts`.

Conventions:
- Adapters return `AdapterResult` (`{ok:true,data}` / `{ok:false,error}`); do not throw
  across the adapter boundary, so one failing chain never breaks a whole tool call.
- `capabilities` gates which tools call an adapter (`registry.withCapability`).
- Every chain-data fix gets a test with a **real captured JSON** in `tests/fixtures/<chain>/`.

## Migros specifics (src/adapters/migros/)

- Uses npm `migros-api-wrapper` (no `client.ts`). Calls migros.ch's internal JSON
  endpoints, the same ones the website uses — unofficial, undocumented, may change.
- Flow: `loginGuestToken()` → `searchProduct` returns **only uids** → `getProductDetails`
  returns full product JSON (price, promotion, badges, nutrition table).
- Two ids: `migrosId` 12 digits (e.g. `107112500000`, used in URLs, exposed as `id`) and
  `uid` 9 digits (e.g. `100001926`, required by product-detail and stock). `getProduct`
  currently accepts only a uid — known gap.
- Region: `MIGROS_REGION` env, default `'2'` (Zürich). `'national'` hides regional prices.
  Search results differ by region (fewer hits with `2`).
- Promotions (`promotions.ts`): `promotion/search` returns max 100 items/request and
  reports `numberOfItems` (≈1150/week) → must page; it ignores free text → filter locally
  with `textMatches` (all words, case/accent/apostrophe-insensitive). With a query, hits
  from a normal search that carry a promotion are merged in. ~24 requests per call → slow.
  Untested speed-up: `filters: { brand: ["chicco-doro"] }` works on promotion/search.
- Badges: `PERCENTAGE_PROMOTION` ("40%"), `MINIMUM_PIECES` ("Ab 2 Stück"). With
  MINIMUM_PIECES, `promotionPrice` applies only from N pieces → `price.current` stays the
  single-piece price; the deal goes into `promotion.description`.

## Known pitfalls

- **zod strips unknown nested keys.** `MigrosProductDetailSchema` is passthrough at top
  level and on `offer`, but `productInformation` is not → `nutrientsInformation` is dropped
  in `searchProducts` (not in `getProduct`, which skips the schema). Add `.passthrough()`
  on any nested object whose extra fields you need.
- Migros `name` is generic ("Bohnenkaffee"); brand is separate; full text is `raw.title`.
- `matcher.ts` strips the brand from the name before scoring and never scores brand →
  "Chicco Bohnen" matches any cheap Bohnenkaffee. Changing Migros names to the full title
  makes such queries fall below `SCORE_THRESHOLD` (0.3) — update the matcher at the same time.
- Nutrition is not normalized at all in v0.7.4.
- Otto's promotion keyword match is too loose (returns "Baffo d'Oro" for "Chicco d'Oro");
  Aldi `getPromotions` returns plain search results, not real promotions.
- Env vars still carry the old `SWISSGROCERIES_` prefix: `SWISSGROCERIES_DISABLE_CACHE`,
  `SWISSGROCERIES_LOG_LEVEL`, `SWISSGROCERIES_USER_AGENT_COOP`; also `DENNER_JWT`,
  `LIDL_DEFAULT_STORE`.

## Commits

Small, one concern each; message explains the real-data reason. Run `npm test` and
`npx tsc --noEmit` before committing.
