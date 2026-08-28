# SmartBill MCP Server

[![CI](https://github.com/mihai-dulgheru/smartbill-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/mihai-dulgheru/smartbill-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/smartbill-mcp-server)](https://www.npmjs.com/package/smartbill-mcp-server)
[![license](https://img.shields.io/npm/l/smartbill-mcp-server)](./LICENSE)

An [MCP](https://modelcontextprotocol.io) server for the [SmartBill Cloud API](https://api.smartbill.ro/).
It exposes all 29 API operations as individually schema-validated tools, so an AI assistant can issue
invoices, record payments, query stock and read your client catalogue.

Covers API **V1** (invoicing, proformas, payments, stock, configuration) and API **V3** (clients,
suppliers, products, warehouses).

> Community project. Not affiliated with or endorsed by SmartBill.

## Quick start

Get your credentials from [cloud.smartbill.ro/core/integrari](https://cloud.smartbill.ro/core/integrari/)
(the **API** section has your email, token and CIF), then add the server to your MCP client.

**Claude Code:**

```bash
claude mcp add smartbill \
  --env SMARTBILL_EMAIL=you@example.com \
  --env SMARTBILL_TOKEN=your-v1-token \
  --env SMARTBILL_V3_TOKEN=your-v3-token \
  --env SMARTBILL_CIF=RO12345678 \
  -- npx -y smartbill-mcp-server
```

**Claude Desktop, Cursor, or any client using `mcpServers` JSON:**

```json
{
  "mcpServers": {
    "smartbill": {
      "command": "npx",
      "args": ["-y", "smartbill-mcp-server"],
      "env": {
        "SMARTBILL_EMAIL": "you@example.com",
        "SMARTBILL_TOKEN": "your-v1-token",
        "SMARTBILL_V3_TOKEN": "your-v3-token",
        "SMARTBILL_CIF": "RO12345678"
      }
    }
  }
}
```

Then ask for something:

> "List my invoice series, then issue a draft invoice on TEST for Acme SRL - one consulting hour at 250 RON."

The assistant reads your configured series and VAT rates first, because those values are
account-specific and must not be guessed.

Requires **Node 20 or newer**.

## Configuration

Credentials come from environment variables and never pass through the model's context.

| Variable                 | Required for             | Default                             |
| ------------------------ | ------------------------ | ----------------------------------- |
| `SMARTBILL_EMAIL`        | API V1 tools             | -                                   |
| `SMARTBILL_TOKEN`        | API V1 tools             | -                                   |
| `SMARTBILL_V3_TOKEN`     | API V3 tools             | -                                   |
| `SMARTBILL_CIF`          | default company VAT code | -                                   |
| `SMARTBILL_BASE_URL`     | -                        | `https://ws.smartbill.ro/SBORO/api` |
| `SMARTBILL_DOWNLOAD_DIR` | where PDFs are written   | OS temp directory                   |

V1 and V3 credentials are independent: configure one and only that half of the tools registers.
Configure neither and the server still starts, reporting an empty tool list and logging what is
missing to stderr. Every tool takes an optional `cif` argument that overrides `SMARTBILL_CIF`.

## Tools

### Invoices

| Tool                                   | Does                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `smartbill_create_invoice`             | Issue an invoice                                                                     |
| `smartbill_create_storno_invoice`      | Issue a reversal of an existing invoice                                              |
| `smartbill_get_invoice_pdf`            | Download the PDF to disk                                                             |
| `smartbill_get_invoice_payment_status` | Paid, unpaid and total amounts                                                       |
| `smartbill_cancel_invoice`             | Cancel. Idempotent - cancelling an already-cancelled invoice still succeeds          |
| `smartbill_restore_invoice`            | Undo a cancel. Idempotent                                                            |
| `smartbill_delete_invoice`             | Delete permanently. Only the most recent invoice in a series can normally be deleted |

### Proformas

`smartbill_create_estimate`, `smartbill_get_estimate_pdf`, `smartbill_get_estimate_invoices`,
`smartbill_cancel_estimate`, `smartbill_restore_estimate`, `smartbill_delete_estimate`

Cancel and restore are idempotent like their invoice counterparts.
`smartbill_get_estimate_invoices` lists the invoices issued from a proforma, and succeeds with an
informational message when none exist yet. Watch for drafts in that list: they appear with an empty
`number` while still setting `areInvoicesCreated: true`, so ignore entries with an empty `number`
when you only care about issued invoices.

### Payments

`smartbill_create_payment`, `smartbill_get_payment_receipt_text`, `smartbill_delete_receipt`,
`smartbill_delete_payment`

`smartbill_delete_receipt` is the only way to delete a Chitanta, and only the most recent receipt in
its series can normally be deleted. `smartbill_delete_payment` covers every other payment type and
explicitly rejects Chitanta and Bon fiscal.

### Company data

`smartbill_get_tax_and_series`, `smartbill_get_series`, `smartbill_get_stocks`,
`smartbill_send_document_email`

`smartbill_get_tax_and_series` returns VAT rates only, despite the name - use `smartbill_get_series`
for series. `smartbill_send_document_email` requires `subject` and `bodyText`, when supplied, to
already be Base64-encoded.

### API V3 (read-only)

`smartbill_v3_list_clients` / `smartbill_v3_get_client`, and the same pair for `suppliers`,
`products` and `warehouses`. Listings are cursor-paginated: `limit` is 1-100 (default 20), and
`after`/`before` are mutually exclusive. Ids carry a resource prefix (`cus_`, `sup_`, `prod_`,
`ware_`) and are stable, so you can store them.

## Things worth knowing

- **`seriesName`, `taxName` and `measuringUnitName` are account-specific** and must match your
  SmartBill configuration exactly. Read series from `smartbill_get_series`, VAT rate names from
  `smartbill_get_tax_and_series`, and units of measure from `smartbill_get_stocks` or
  `smartbill_v3_list_products` - the tax endpoint does not return units.
- **Product prices exclude VAT by default.** Set `isTaxIncluded: true` only when the price already
  includes it.
- **`discountType` picks which discount field applies, and SmartBill will not catch a wrong one.**
  `1` is a value-based discount taking `discountValue` (strictly negative, e.g. `-10`); `2` is a
  percentage discount taking `discountPercentage` (greater than 0, up to 100). The API does not
  reject an out-of-range `discountType` - it silently produces a wrong document. This server only
  accepts `1` or `2` and enforces the matching field, but the pairing is still yours to get right.
- **Requests are validated locally before any HTTP call.** Non-negative `price`, strictly negative
  `discountValue`, `discountPercentage` in (0, 100], valid email addresses, `yyyy-MM-dd` dates and a
  V3 `limit` between 1 and 100 are all rejected client-side.
- **An HTTP 200 from API V1 is not proof of success.** The server checks `errorText` on every
  response and reports a non-empty one as a tool error - which is why a raw `curl` against the API
  can look like it worked when it did not.
- **Five operations are idempotent by design**: cancelling or restoring an invoice or proforma
  already in that state succeeds with an informational message, as does asking
  `smartbill_get_estimate_invoices` about a proforma not yet invoiced.
- **PDFs go to disk**, not into the conversation. They are written to `SMARTBILL_DOWNLOAD_DIR` with
  a sanitised filename that cannot escape that directory; the tool returns the path and byte count.
- **Rate limits are tracked per server process.** V1 allows 30 requests per 10 seconds and blocks the
  token for 10 minutes on a breach; V3 allows 60 per 10 seconds. A process delays its own requests
  rather than breaching either, and backs off when the API's own `X-RateLimit-Remaining` reports the
  window exhausted. The limit is per token and cumulative, though: several clients sharing one token
  each track only their own requests, so together they can still breach it.
- **Deletes are irreversible**, and four tools are marked destructive so your client can prompt
  before running them. For an invoice already sent to a client, issue a storno instead of deleting.

## Development

```bash
npm install
npm run check      # format:check -> lint -> typecheck -> test
npm run build
```

| Script              | Does                                      |
| ------------------- | ----------------------------------------- |
| `npm test`          | `node:test` suite, no network calls       |
| `npm run lint`      | ESLint with type-aware rules              |
| `npm run lint:fix`  | ESLint with autofix                       |
| `npm run format`    | Prettier write                            |
| `npm run typecheck` | `tsc` over `src/` and `test/`             |
| `npm run check`     | everything above, in the order CI runs it |
| `npm run build`     | compile `src/` to `dist/`                 |

Running the tests needs **Node 22.18+ or 23.6+** - `npm test` executes `test/*.test.ts` directly via
Node's native TypeScript type stripping, which shipped unflagged only from those versions. That is
stricter than the Node 20 needed to _run_ the built server.

To exercise the server by hand against a real account, put your credentials in a `.env` file
(git-ignored) and let Node load it:

```bash
npm run build
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node --env-file=.env dist/index.js
```

`test/coverage.test.ts` asserts that every operation in `docs/smartbill-openapi-spec.json` maps to
exactly one tool, so the spec file is the source of truth for the tool surface - update it and the
test will name whatever is unwired.

## Releasing

Publishing runs in CI, triggered by a version tag, so no npm token lives on a developer
machine and every release carries a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements).

```bash
npm run release:patch   # or release:minor / release:major
```

That runs the full check, bumps the version, commits, tags and pushes the tag. The
[Release workflow](./.github/workflows/release.yml) then verifies the tag matches
`package.json`, refuses a version that is already on npm, re-runs the checks, smoke-tests
the built server, and publishes with `--provenance`.

Authentication uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) over
OIDC, so there is no npm token anywhere - not on a developer machine, not in repository
secrets.

`npm run release:dry` rehearses the tarball locally without publishing anything.

## License

MIT - see [LICENSE](./LICENSE).
