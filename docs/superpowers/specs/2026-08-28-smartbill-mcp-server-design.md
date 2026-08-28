# SmartBill MCP Server — Design

**Date:** 2026-08-28
**Status:** Approved
**Source of truth:** `docs/smartbill-openapi-spec.json` (OpenAPI 3.1.0, `info.x-last-updated: 2026-08-21`)

## 1. Purpose

An MCP server exposing the complete SmartBill Cloud API to MCP clients. Every operation in the
OpenAPI spec becomes one MCP tool, with schemas and descriptions that carry the API's
non-obvious behaviour so a model can call it correctly on the first try.

The documentation site at `https://api.smartbill.ro/` is a single-page renderer over this same
spec: its guide pages (Introducere, Quickstart, Autentificare V1/V3, Raspunsuri, Reguli generale
de format, Paginare, Erori, Rate Limiting) live in `info.description`, and its per-resource pages
live in the tag descriptions. The local spec file is therefore complete and authoritative; no
separate scrape is required.

### Scope

In scope: all 29 operations in the spec, over stdio, credentials from environment variables.

Out of scope: HTTP transport, per-call credential overrides, write operations on API V3 (the
spec exposes V3 as read-only), NIR-uri (marked "in curand" in the spec with no operations).

## 2. The API being wrapped

Two APIs behind one base URL, with different auth, error shapes and rate limits.

| | V1 | V3 (beta) |
|---|---|---|
| Base | `https://ws.smartbill.ro/SBORO/api` | `https://ws.smartbill.ro/SBORO/api/v3` |
| Auth | HTTP Basic, `email:token` | `Authorization: Bearer <token>` |
| Company | `companyVatCode` in body, or `cif` query param | `{cif}` path segment |
| Operations | 21 | 8, all reads |
| Errors | `errorText`, plus a second `invalid_request_error` shape | `{status, type, instance, errors[]}` |
| Pagination | none | cursor: `limit` (1–100, default 20), `after`, `before` |
| Rate limit | 30 req / 10s, **10-minute lockout on breach** | 60 read + 30 write / 10s, 50 000/day |

### 2.1 Behaviours the wrapper must encode

These come from `info.description` and are the reason a hand-written tool layer beats codegen.

1. **A V1 HTTP 200 is not success.** `errorText` is the source of truth: empty means success,
   non-empty carries the failure reason. Treating 200 as success silently reports failed invoices
   as issued.
2. **V1 has a second error shape with no `errorText`.** An unrecognised field name, a wrong value
   type, or malformed JSON is rejected before the billing logic and returns
   `{status, type: "invalid_request_error", instance, errors: [{code, message, docUrl, param}]}`.
   `errors[].param` names the exact offending field, including paths such as `products[0].quantity`
   and `estimate.paymentUrl`. Codes: `json_mapping_error`, `json_parse_error`,
   `invalid_accept_header`, `method_not_allowed`. The same shape covers 405 and 415.
3. **`errorText` may contain HTML.** Stock-discharge errors embed `<br/>`, `<b>`, and a
   `<div id="moreErrorDetails" style="display:none">` block. The cause is the first sentence; the
   rest is help text for the SmartBill Cloud UI. Truncate at the first `<`.
4. **A misspelled field can return HTTP 500 with an HTML body.** Per the spec, this is not a real
   server fault — it means the payload has a bad field name.
5. **V3 returns multiple errors at once.** Clients must process the whole `errors` array, and
   branch on `type` + `errors[].code`, never on `message` text.
6. **Account-dependent strings.** `seriesName`, `taxName` and `measuringUnitName` must match values
   configured in the user's SmartBill Cloud account exactly. They must never be invented; they come
   from `GET /series`, `GET /tax`, or from the user.
7. **V1 prices exclude VAT by default** (`isTaxIncluded: false`). Setting it wrongly changes the
   invoice total.
8. **Booleans accept `1`/`0`; percentages are bare numbers.** `taxPercentage: "21%"` returns 400.
9. **V3 ids are prefixed and stable**: `cus_` clients, `sup_` suppliers, `ware_` warehouses,
   `prod_` products. An id used on the wrong resource returns 400 `malformed_id`. Ids double as
   pagination cursors.
10. **V3 `pagination.next` is a complete URL** carrying the original filters, and is `null` on the
    last page even when that page filled exactly to `limit`.
11. **Rate limits are severe on V1**: breaching 30 requests per 10 seconds blocks the token for
    10 minutes. On 429/503 the `Retry-After` header is authoritative and can escalate through
    `5, 10, 20, 40, 80, 160, 300, 600` seconds.

## 3. Architecture

```
                    stdio (JSON-RPC)
                          |
                    src/index.ts            entry: build config, register tools, connect
                          |
        +-----------------+-----------------+
        |                 |                 |
   src/tools/*.ts    src/schemas.ts    src/config.ts
   29 registerTool   zod mirrors of    env parsing +
   calls, grouped    spec components   credential presence
   by spec tag
        |
   src/client.ts     one request(): URL + query, auth per API version,
        |            content-type dispatch, rate-limit guard, retry
        |
   src/errors.ts     normalise 5 failure shapes into one result type
        |
                     global fetch
```

Dependencies: `@modelcontextprotocol/server@^2` and `zod@^4`. Nothing else at runtime. Dev:
`typescript`, `@types/node`. Tests use `node:test` and `node:assert` from the standard library.

The SDK v2 API, verified against the published package types:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new McpServer({ name: 'smartbill', version: '1.0.0' });
server.registerTool(
  'smartbill_get_series',
  { title, description, inputSchema: z.object({ ... }), annotations: { readOnlyHint: true } },
  async (args) => ({ content: [{ type: 'text', text }], structuredContent, isError }),
);
await server.connect(new StdioServerTransport());
```

`inputSchema` takes a `z.object(...)` (the raw-shape form is deprecated in v2). Node >= 20.

### 3.1 Module responsibilities

| Module | Does | Depends on |
|---|---|---|
| `src/config.ts` | Read and validate env, expose `Config`, report which credential sets are present | — |
| `src/client.ts` | `request(spec)` — one HTTP call: URL, query, auth, headers, body, response decode, rate-limit guard, one retry | `config`, `errors` |
| `src/errors.ts` | Turn any SmartBill failure into `SmartBillError`; strip HTML from `errorText` | — |
| `src/schemas.ts` | zod mirrors of spec `components.schemas` reused across tools | `zod` |
| `src/tools/*.ts` | One `register(server, client)` per tag group, calling `registerTool` | `client`, `schemas` |
| `src/index.ts` | Wire the above; connect stdio | all |

Each tool module can be read and tested without the others. `client.ts` never knows what a tool is;
tools never build URLs or headers.

## 4. Configuration

All configuration is environment variables. Credentials never travel through the model's context.

| Variable | Required for | Default |
|---|---|---|
| `SMARTBILL_EMAIL` | V1 tools | — |
| `SMARTBILL_TOKEN` | V1 tools | — |
| `SMARTBILL_V3_TOKEN` | V3 tools | — |
| `SMARTBILL_CIF` | default company | — |
| `SMARTBILL_BASE_URL` | — | `https://ws.smartbill.ro/SBORO/api` |
| `SMARTBILL_DOWNLOAD_DIR` | PDF destination | `os.tmpdir()` |

Behaviour:

- V1 credentials absent: the 21 V1 tools are not registered. V3 token absent: the 8 V3 tools are
  not registered. The server still starts and reports what it registered, so a partially
  configured account is usable rather than dead.
- Both credential sets absent: the server starts, registers nothing, and logs the required
  variables to stderr.
- `cif` is optional on every tool and falls back to `SMARTBILL_CIF`. If neither is present, the
  tool returns a clear error naming both ways to supply it, without making an HTTP call.

**All diagnostics go to stderr.** stdout carries the MCP JSON-RPC wire; writing to it corrupts the
session. `Authorization` headers, tokens and passwords are never logged, at any level.

## 5. HTTP client

`request()` takes `{ api: 'v1' | 'v3', method, path, query?, body?, accept? }` and returns
`{ data, status, headers, rateLimit }`.

- **Auth.** `v1` sets `Authorization: Basic base64(email:token)`; `v3` sets
  `Authorization: Bearer <v3token>`.
- **Headers.** `Accept: application/json` by default, `Content-Type: application/json` when a body
  is present. PDF calls send `Accept: application/octet-stream`.
- **Query.** Undefined and null values are dropped; booleans serialise as `true`/`false`; numbers
  bare. `cif` resolution happens before the call.
- **Response decode by `Content-Type`**, not by expectation. A PDF endpoint returns JSON when it
  fails, so the branch is on the actual header: `application/json` parses, `application/octet-stream`
  buffers, `text/html` becomes the "likely a misspelled field" error of §2.1(4).
- **Rate-limit guard.** A sliding window per API — 30 requests / 10s for V1, 60 / 10s for V3 —
  delays a request that would breach it rather than sending it. This exists specifically because a
  V1 breach costs a 10-minute lockout on the whole token, and a model looping over invoices can
  trip it trivially. V3's separate 30/10s write limit is not implemented: every V3 operation in the
  spec is a read, so no write window can be reached.
- **Retry.** On 429 or 503 carrying `Retry-After`, wait the stated seconds and retry **once**.
  No retry on any other status: per the spec's own guidance, 4xx responses will not become
  successful on repeat. `Retry-After` values above a 60-second ceiling are surfaced as an error
  rather than slept through, so a tool call cannot hang for ten minutes.
- **Rate-limit headers** (`X-RateLimit-Limit`, `-Remaining`, `-Reset`, and the V3
  `X-RateLimit-Daily-*`) are parsed and attached to every result.

## 6. Error normalisation

One shape out, whatever came in:

```ts
type SmartBillError = {
  message: string;        // first sentence, HTML stripped
  code?: string;          // json_mapping_error, missing_required_field, ...
  type?: string;          // invalid_request_error, validation_error, ...
  param?: string;         // products[0].quantity
  httpStatus: number;
  details?: unknown[];    // every element of a V3 errors[] beyond the first
  hint?: string;          // actionable next step where one is known
};
```

The five inputs:

| Input | Detection | Result |
|---|---|---|
| V1 business failure | JSON body, `errorText` non-empty (**even on HTTP 200**) | `message` = `errorText` up to the first `<` |
| V1 invalid request | JSON body with `type` and `errors[]`, no `errorText` | `code`/`param` from `errors[0]`, rest into `details` |
| V1 HTML 500 | `Content-Type: text/html` | `hint`: check field names against the schema — not a server fault |
| V3 problem | JSON body with `status`, `type`, `errors[]` | first error into `code`/`param`, **all** errors into `details` |
| Transport failure | fetch rejects | `httpStatus: 0`, network message |

Every failing tool returns `isError: true` with the message, code and param rendered as text, plus
the structured error. The success path returns the parsed body as `structuredContent` and a compact
text rendering as `content`.

## 7. Tool surface

29 tools, one per spec operation, all prefixed `smartbill_`. `R` = `readOnlyHint`,
`D` = `destructiveHint`.

### Invoices — `src/tools/invoices.ts`

| Tool | Operation | Hint |
|---|---|---|
| `smartbill_create_invoice` | `POST /invoice/v2` | |
| `smartbill_create_storno_invoice` | `POST /invoice/reverse` | |
| `smartbill_get_invoice_pdf` | `GET /invoice/pdf` | R |
| `smartbill_get_invoice_payment_status` | `GET /invoice/paymentstatus` | R |
| `smartbill_cancel_invoice` | `PUT /invoice/cancel` | |
| `smartbill_restore_invoice` | `PUT /invoice/restore` | |
| `smartbill_delete_invoice` | `DELETE /invoice` | D |

### Estimates — `src/tools/estimates.ts`

| Tool | Operation | Hint |
|---|---|---|
| `smartbill_create_estimate` | `POST /estimate/v2` | |
| `smartbill_get_estimate_pdf` | `GET /estimate/pdf` | R |
| `smartbill_get_estimate_invoices` | `GET /estimate/invoices` | R |
| `smartbill_cancel_estimate` | `PUT /estimate/cancel` | |
| `smartbill_restore_estimate` | `PUT /estimate/restore` | |
| `smartbill_delete_estimate` | `DELETE /estimate` | D |

### Payments — `src/tools/payments.ts`

| Tool | Operation | Hint |
|---|---|---|
| `smartbill_create_payment` | `POST /payment` | |
| `smartbill_get_payment_receipt_text` | `GET /payment/text` | R |
| `smartbill_delete_receipt` | `DELETE /payment/chitanta` | D |
| `smartbill_delete_payment` | `DELETE /payment/v2` | D |

### Company data — `src/tools/company.ts`

| Tool | Operation | Hint |
|---|---|---|
| `smartbill_get_tax_and_series` | `GET /tax` | R |
| `smartbill_get_series` | `GET /series` | R |
| `smartbill_get_stocks` | `GET /stocks` | R |
| `smartbill_send_document_email` | `POST /document/send` | |

### V3 — `src/tools/v3.ts`

All read-only. Eight tools: `list` and `get` for each of clients, suppliers, products, warehouses,
mapping to `GET /v3/companies/{cif}/{resource}` and `.../{resource}/{id}`.

Cancel and restore are marked non-destructive: they are a reversible pair, and flagging cancel as
destructive would train clients to over-confirm a routine action. The four deletes are genuinely
irreversible and carry `destructiveHint`.

### 7.1 Descriptions

Tool descriptions are where the §2.1 behaviours land. Each description states what the tool does,
then any trap that applies to it:

- Creation tools state that prices exclude VAT unless `isTaxIncluded` is set, and that
  `seriesName`, `taxName` and `measuringUnitName` must come from the account rather than being
  guessed — pointing at `smartbill_get_series` for `seriesName`, `smartbill_get_tax_and_series` for
  `taxName`, and `smartbill_get_stocks` or `smartbill_v3_list_products` (or asking the user) for
  `measuringUnitName`, since no V1 endpoint returns units.
- `smartbill_delete_payment` states that `paymentType` must match the payment actually recorded on
  the invoice, and cannot be `Chitanta` or `Bon fiscal`.
- V3 list tools state the cursor rules: `after` and `before` are mutually exclusive, `limit` is
  1–100, `next: null` means the listing is finished.
- V3 get tools state the id prefix they accept.
- `smartbill_get_stocks` states that `warehouseName` is case-sensitive and `date` is `yyyy-MM-dd`.

### 7.2 PDF handling

`GET /invoice/pdf` and `GET /estimate/pdf` return `application/octet-stream`. The tool writes the
bytes to `SMARTBILL_DOWNLOAD_DIR` as `{cif}-{series}-{number}.pdf` and returns `{ path, bytes }`.
The cif is included because it is a per-call argument: without it, two companies sharing the same
series and number would overwrite each other's PDF in one download directory.
Re-downloading the same document overwrites the file rather than accumulating copies.
Base64-inlining a PDF would consume roughly 1.4x its size in context for no benefit, since the
model cannot read PDF bytes directly. The directory is created if absent; a write failure is
reported as a tool error with the target path named.

## 8. Testing

`node:test` with `node:assert`, `fetch` stubbed. No network calls in the suite.

| Test | Asserts |
|---|---|
| `test/coverage.test.ts` | Every `operationId` in the spec maps to exactly one registered tool, and every registered tool maps to a spec operation. This is the guard against the drift that hand-writing invites. |
| `test/errors.test.ts` | Each of the five inputs in §6 normalises correctly. Explicitly: HTTP 200 with non-empty `errorText` is an error; `errorText` containing `<b>` truncates at the first `<`; a V3 body with two errors surfaces both. |
| `test/client.test.ts` | Basic vs Bearer selected per api; query drops undefined; `cif` falls back to env then errors; content-type dispatch picks the right decoder; rate-limit headers parsed. |
| `test/ratelimit.test.ts` | The sliding window delays the 31st V1 request within 10s and the 61st V3 request; `Retry-After` is honoured once; a `Retry-After` above the ceiling errors rather than sleeping. |

Every test asserts on behaviour reachable through the public surface of its module.

## 9. Deliverables

```
package.json  tsconfig.json  README.md  .env.example  .gitignore
src/index.ts  src/config.ts  src/client.ts  src/errors.ts  src/schemas.ts
src/tools/{invoices,estimates,payments,company,v3}.ts
test/{coverage,errors,client,ratelimit}.test.ts
```

`README.md` covers installation, the environment variables, the MCP client configuration block,
the full tool list, and the account-dependent-strings caveat.

## 10. Decisions and their reasons

| Decision | Reason |
|---|---|
| Hand-written tools, not generated from the spec | The value is in the descriptions and error normalisation of §2.1, which no generator derives from the schema. Drift is guarded by `coverage.test.ts` instead. |
| One tool per operation | Preserves per-operation schema validation, which a consolidated `action` enum loses. |
| `@modelcontextprotocol/server@2`, not `@modelcontextprotocol/sdk@1` | v2 is the stable line and, for a stdio server, pulls two dependencies instead of eighteen. |
| Global `fetch`, `node:test` | Present in Node 20+. No HTTP or test framework dependency is needed. |
| Env-only credentials | Keeps secrets out of model context. |
| Client-side rate-limit guard | A V1 breach locks the token for 10 minutes; a model looping over documents trips 30/10s easily. |
| Retry once, with a ceiling | The spec says 4xx will not succeed on retry, and an escalating `Retry-After` can reach 600 seconds — too long to hold a tool call open. |
| PDFs to disk | Base64 in context costs ~1.4x file size and the model cannot read the bytes anyway. |
