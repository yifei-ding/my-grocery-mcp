# my-grocery-mcp

Personal MCP server for Swiss grocery product search, price comparison and
weekly promotions (Migros, Coop, Aldi, Denner, Lidl, Farmy, Volgshop, Otto's).

## Origin and license

Forked from [nicktcode/swissgroceries-mcp](https://github.com/nicktcode/swissgroceries-mcp)
at **v0.7.4**, the last release under the MIT License. Later upstream releases
use different licenses; no code from them is included here. This project stays
under MIT — see [LICENSE](LICENSE). The original README is kept as
[UPSTREAM-README.md](UPSTREAM-README.md) for reference on tools and setup.

Not affiliated with any of the retailers. It calls their publicly reachable
app/web endpoints; those can change without notice.

## Changes since the fork

See `git log`. Highlights:

- Migros: promotions with a minimum quantity ("40% Ab 2 Stück") are detected.
- Migros: `get_promotions` reads the full weekly list and honours `query`.
- Migros: `search_products` keeps promotion data.
- Migros: default region is Zürich (`2`), overridable via `MIGROS_REGION`.

## Run locally

```bash
npm install
npm test
npm run build
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-grocery": {
      "command": "node",
      "args": ["/absolute/path/to/my-grocery-mcp/dist/index.js"]
    }
  }
}
```
