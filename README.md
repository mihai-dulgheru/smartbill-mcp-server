# SmartBill MCP Server

An MCP server exposing the [SmartBill Cloud API](https://api.smartbill.ro/) — all 29 operations
across API V1 (invoicing, payments, stock, configuration) and API V3 (clients, suppliers,
products, warehouses).

## Install

```bash
npm install
npm run build
```

Requires Node 20 or newer to run the built server (also enough to build it — `tsc` doesn't need a
newer Node). Running the test suite from source needs a newer Node — see Development.

## Configuration

Credentials come from environment variables and never pass through the model's context. Get them
from [cloud.smartbill.ro/core/integrari](https://cloud.smartbill.ro/core/integrari/).

| Variable | Required for | Default |
|---|---|---|
| `SMARTBILL_EMAIL` | API V1 tools | — |
| `SMARTBILL_TOKEN` | API V1 tools | — |
| `SMARTBILL_V3_TOKEN` | API V3 tools | — |
| `SMARTBILL_CIF` | default company VAT code | — |
| `SMARTBILL_BASE_URL` | — | `https://ws.smartbill.ro/SBORO/api` |
| `SMARTBILL_DOWNLOAD_DIR` | where PDFs are written | OS temp directory |

V1 and V3 credentials are independent: configure one and only that half of the tools is
registered. Every tool takes an optional `cif` argument that overrides `SMARTBILL_CIF`.

## MCP client configuration

```json
{
  "mcpServers": {
    "smartbill": {
      "command": "node",
      "args": ["/absolute/path/to/smartbill-mcp-server/dist/index.js"],
      "env": {
        "SMARTBILL_EMAIL": "you@example.com",
        "SMARTBILL_TOKEN": "...",
        "SMARTBILL_V3_TOKEN": "...",
        "SMARTBILL_CIF": "RO12345678"
      }
    }
  }
}
```

In Claude Code: `claude mcp add smartbill --env SMARTBILL_EMAIL=... --env SMARTBILL_TOKEN=... --env SMARTBILL_CIF=... -- node /absolute/path/to/dist/index.js`

## Tools

### Invoices

| Tool | Does |
|---|---|
| `smartbill_create_invoice` | Issue an invoice |
| `smartbill_create_storno_invoice` | Issue a reversal of an existing invoice |
| `smartbill_get_invoice_pdf` | Download the PDF to disk |
| `smartbill_get_invoice_payment_status` | Paid, unpaid and total amounts |
| `smartbill_cancel_invoice` | Cancel. Idempotent — cancelling an already-cancelled invoice still succeeds |
| `smartbill_restore_invoice` | Undo a cancel. Idempotent |
| `smartbill_delete_invoice` | Delete permanently. Only the most recent invoice in a series can normally be deleted |

### Proformas

`smartbill_create_estimate`, `smartbill_get_estimate_pdf`, `smartbill_get_estimate_invoices`,
`smartbill_cancel_estimate`, `smartbill_restore_estimate`, `smartbill_delete_estimate`

`smartbill_cancel_estimate` and `smartbill_restore_estimate` are idempotent like their invoice
counterparts. `smartbill_get_estimate_invoices` lists the invoices issued from a proforma so you
can check whether it has already been invoiced; calling it on a proforma with no invoice yet also
succeeds, carrying an informational message instead of an error. Watch for draft invoices in that
list: they appear with an empty `number` while still setting `areInvoicesCreated: true`, so ignore
entries with an empty `number` when you only care about issued invoices.

### Payments

`smartbill_create_payment`, `smartbill_get_payment_receipt_text`, `smartbill_delete_receipt`,
`smartbill_delete_payment`

`smartbill_delete_receipt` is the only way to delete a Chitanta, and only the most recent receipt
in its series can normally be deleted. `smartbill_delete_payment` covers every other payment type
and explicitly rejects Chitanta and Bon fiscal.

### Company data

`smartbill_get_tax_and_series`, `smartbill_get_series`, `smartbill_get_stocks`,
`smartbill_send_document_email`

`smartbill_get_tax_and_series` returns VAT rates only, despite the name — it does not return
company information. `smartbill_send_document_email` requires `subject` and `bodyText`, when
supplied, to already be Base64-encoded.

### API V3 (read-only)

`smartbill_v3_list_clients` / `smartbill_v3_get_client`, and the same pair for `suppliers`,
`products` and `warehouses`. Listings are cursor-paginated: `limit` is 1-100 (default 20), and
`after`/`before` are mutually exclusive.

## Things worth knowing

- **`seriesName`, `taxName` and `measuringUnitName` are account-specific.** They must match what is
  configured in SmartBill Cloud exactly. Read them with `smartbill_get_series` and
  `smartbill_get_tax_and_series` rather than guessing.
- **Product prices exclude VAT by default.** Set `isTaxIncluded: true` only when the price already
  includes it.
- **`discountType` picks which discount field applies, and SmartBill will not catch a wrong one.**
  `1` is a value-based discount and takes `discountValue` (must be strictly negative, e.g. `-10`);
  `2` is a percentage discount and takes `discountPercentage` (greater than 0, up to 100). The
  SmartBill API itself does not reject an out-of-range `discountType` — it silently produces a
  wrong document — so this is the easiest way to end up with a wrong invoice. This server's schema
  only accepts `1` or `2` and enforces the matching field, but the pairing is still yours to get
  right.
- **Requests are validated locally before any HTTP call.** Non-negative `price`, strictly negative
  `discountValue`, `discountPercentage` in (0, 100], valid email addresses, `yyyy-MM-dd` dates, and
  a V3 `limit` between 1 and 100 are all rejected client-side rather than sent to SmartBill.
- **An HTTP 200 from API V1 is not proof of success.** The server checks `errorText` on every
  response and reports a non-empty one as a tool error, so this is handled — but it is why a raw
  `curl` against the API can look like it worked when it did not.
- **Five operations are idempotent by design**: cancelling or restoring an invoice or proforma that
  is already in that state succeeds with an informational message rather than a tool error, and so
  does asking `smartbill_get_estimate_invoices` about a proforma that has not been invoiced yet.
- **PDFs go to disk**, not into the conversation. They are written to `SMARTBILL_DOWNLOAD_DIR` with
  a sanitised filename that cannot escape that directory, and the tool returns the resulting path
  and byte count.
- **Rate limits are enforced client-side.** V1 allows 30 requests per 10 seconds and blocks the
  token for 10 minutes on a breach; V3 allows 60 per 10 seconds. The server delays requests rather
  than letting either limit be breached.
- **Deletes are irreversible.** For an invoice already sent to a client, issue a storno instead.

## Development

Running the test suite needs **Node 22.18+ or 23.6+** — `npm test` executes `test/*.test.ts`
directly via Node's native TypeScript type stripping, which shipped unflagged only from those
versions. That's stricter than the Node 20 in Install: `npm run build` and `npm run typecheck` are
just the `tsc` compiler and run fine there, but Node itself can't load a `.ts` file until 22.18/23.6.

```bash
npm test          # node:test, no network
npm run typecheck
npm run build
```

`test/coverage.test.ts` asserts that every operation in `docs/smartbill-openapi-spec.json` has
exactly one tool. Update the spec file and it will tell you what is missing.
