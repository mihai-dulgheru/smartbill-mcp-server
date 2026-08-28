# SmartBill MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP server over stdio exposing all 29 SmartBill Cloud API operations as individually-schema'd tools, with the API's non-obvious failure behaviour normalised so a model calls it correctly.

**Architecture:** A single HTTP client (`client.ts`) handles auth, query building, content-type dispatch, rate limiting and retry. An error normaliser (`errors.ts`) collapses SmartBill's five distinct failure shapes into one type — critically, a V1 HTTP 200 with a non-empty `errorText` is a failure. Tools are declared as plain `ToolDef` objects grouped by spec tag and registered by one loop in `index.ts`, which makes both registration and the spec-coverage test trivial.

**Tech Stack:** TypeScript (ESM), Node >= 20, `@modelcontextprotocol/server@^2`, `zod@^4`. Tests use `node:test` + `node:assert` from the standard library. HTTP uses global `fetch`. No other runtime or test dependencies.

**Spec:** `docs/superpowers/specs/2026-08-28-smartbill-mcp-server-design.md`

## Global Constraints

- **Two runtime dependencies only:** `@modelcontextprotocol/server@^2`, `zod@^4`. Dev: `typescript@^5.9`, `@types/node`. Adding any other package requires going back to the spec.
- **Node >= 20** (`@modelcontextprotocol/server@2` requires it). Development is on Node 24.
- **ESM only.** `package.json` has `"type": "module"`. Relative imports carry the `.ts` extension (e.g. `import { loadConfig } from './config.ts'`); `tsc` rewrites them to `.js` on build via `rewriteRelativeImportExtensions`.
- **Erasable TypeScript syntax only.** No `enum`, no `namespace`, no constructor parameter properties. Enforced by `"erasableSyntaxOnly": true`. This is what lets `node --test` run the `.ts` test files directly with no build step.
- **stdout is the MCP wire.** Every diagnostic goes to `stderr` via `console.error`. A `console.log` anywhere in `src/` is a bug.
- **Never log credentials.** No `Authorization` header, token, or password in any log line, at any level.
- **`inputSchema` is a `z.object(...)`**, not a raw shape (the raw-shape form is deprecated in SDK v2).
- **Source of truth** for every schema, enum, parameter and error is `docs/smartbill-openapi-spec.json`. Do not invent field names.
- **API base URL:** `https://ws.smartbill.ro/SBORO/api`. V3 paths are `/v3/companies/{cif}/...` under the same base.
- **No live API calls in tests.** `fetch` is injected and stubbed everywhere.

### Note on version control

The repository is not currently a git repository. Task 1 Step 1 runs `git init`. If the user
prefers not to use git here, skip every `git commit` step in this plan; nothing else depends on
them.

### Deviation from the spec's file list

The spec's §9 sketch put the rate limiter inside `client.ts` and had no shared tool helper. This
plan splits out `src/ratelimit.ts` and `src/tools/shared.ts` so each file keeps one
responsibility and each is independently testable. Everything else matches §9.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | ESM, bin entry, scripts, the two runtime deps |
| `tsconfig.json` | Strict, ESM, `erasableSyntaxOnly`, `.ts` import rewriting |
| `src/config.ts` | Parse env into `Config`; report which credential sets are present |
| `src/errors.ts` | `SmartBillError` type; normalise all five failure shapes; strip HTML |
| `src/ratelimit.ts` | `SlidingWindow` — delays a request that would breach the window |
| `src/client.ts` | `SmartBillClient.request()` — the only place that speaks HTTP |
| `src/schemas.ts` | zod mirrors of the spec's `components.schemas` |
| `src/tools/shared.ts` | `ToolDef` type; `toolResult`, `resolveCif`, `savePdf` helpers |
| `src/tools/invoices.ts` | 7 tools |
| `src/tools/estimates.ts` | 6 tools |
| `src/tools/payments.ts` | 4 tools |
| `src/tools/company.ts` | 4 tools (tax, series, stocks, email) |
| `src/tools/v3.ts` | 8 tools |
| `src/tools/index.ts` | `allTools` — the concatenation, and the only thing `index.ts` imports |
| `src/index.ts` | Build config + client, register tools by capability, connect stdio |
| `test/*.test.ts` | One per module, plus `coverage.test.ts` |
| `README.md`, `.env.example`, `.gitignore` | Docs and hygiene |

---

## Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type Config = {
    email?: string;
    token?: string;
    v3Token?: string;
    cif?: string;
    baseUrl: string;
    downloadDir: string;
    hasV1: boolean;
    hasV3: boolean;
  };
  export function loadConfig(env?: Record<string, string | undefined>): Config;
  ```

- [ ] **Step 1: Initialise the repository and install dependencies**

```bash
cd /c/repositories/smartbill-mcp-server
git init
npm init -y
npm install @modelcontextprotocol/server@^2 zod@^4
npm install --save-dev typescript@^5.9 @types/node
```

- [ ] **Step 2: Write `package.json`**

Replace the generated file with this exactly:

```json
{
  "name": "smartbill-mcp-server",
  "version": "1.0.0",
  "description": "MCP server for the SmartBill Cloud API",
  "type": "module",
  "bin": { "smartbill-mcp-server": "dist/index.js" },
  "main": "dist/index.js",
  "files": ["dist", "README.md"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "node --test test/*.test.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "declaration": false,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`"types": ["node"]` is required — TypeScript 6 no longer auto-includes `@types/*`, and the SDK's
published types reference `Buffer`.

- [ ] **Step 4: Write `.gitignore` and `.env.example`**

`.gitignore`:

```
node_modules/
dist/
.env
*.log
```

`.env.example`:

```
# API V1 — Basic auth. From https://cloud.smartbill.ro/core/integrari/
SMARTBILL_EMAIL=you@example.com
SMARTBILL_TOKEN=

# API V3 — Bearer token. From the same page.
SMARTBILL_V3_TOKEN=

# Default company VAT code (CIF). Every tool accepts a `cif` argument that overrides this.
SMARTBILL_CIF=

# Optional
SMARTBILL_BASE_URL=https://ws.smartbill.ro/SBORO/api
SMARTBILL_DOWNLOAD_DIR=
```

- [ ] **Step 5: Write the failing test**

`test/config.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';

test('defaults baseUrl and downloadDir when unset', () => {
  const c = loadConfig({});
  assert.equal(c.baseUrl, 'https://ws.smartbill.ro/SBORO/api');
  assert.equal(c.downloadDir, tmpdir());
});

test('hasV1 requires both email and token', () => {
  assert.equal(loadConfig({}).hasV1, false);
  assert.equal(loadConfig({ SMARTBILL_EMAIL: 'a@b.co' }).hasV1, false);
  assert.equal(loadConfig({ SMARTBILL_TOKEN: 'tok' }).hasV1, false);
  assert.equal(loadConfig({ SMARTBILL_EMAIL: 'a@b.co', SMARTBILL_TOKEN: 'tok' }).hasV1, true);
});

test('hasV3 requires the v3 token', () => {
  assert.equal(loadConfig({}).hasV3, false);
  assert.equal(loadConfig({ SMARTBILL_V3_TOKEN: 'sb_x' }).hasV3, true);
});

test('trims values and treats blank strings as absent', () => {
  const c = loadConfig({ SMARTBILL_EMAIL: '  a@b.co ', SMARTBILL_TOKEN: '   ' });
  assert.equal(c.email, 'a@b.co');
  assert.equal(c.token, undefined);
  assert.equal(c.hasV1, false);
});

test('strips a trailing slash from baseUrl', () => {
  const c = loadConfig({ SMARTBILL_BASE_URL: 'https://example.test/api/' });
  assert.equal(c.baseUrl, 'https://example.test/api');
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/config.ts`.

- [ ] **Step 7: Write `src/config.ts`**

```ts
import { tmpdir } from 'node:os';

export type Config = {
  email?: string;
  token?: string;
  v3Token?: string;
  cif?: string;
  baseUrl: string;
  downloadDir: string;
  hasV1: boolean;
  hasV3: boolean;
};

const DEFAULT_BASE_URL = 'https://ws.smartbill.ro/SBORO/api';

/** Trim, and treat a blank string as absent. */
const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const email = clean(env.SMARTBILL_EMAIL);
  const token = clean(env.SMARTBILL_TOKEN);
  const v3Token = clean(env.SMARTBILL_V3_TOKEN);

  return {
    email,
    token,
    v3Token,
    cif: clean(env.SMARTBILL_CIF),
    baseUrl: (clean(env.SMARTBILL_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    downloadDir: clean(env.SMARTBILL_DOWNLOAD_DIR) ?? tmpdir(),
    hasV1: Boolean(email && token),
    hasV3: Boolean(v3Token),
  };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 5 tests.

- [ ] **Step 9: Verify the build works**

Run: `npm run typecheck`
Expected: no output, exit 0. If `erasableSyntaxOnly`, `allowImportingTsExtensions` or
`rewriteRelativeImportExtensions` is rejected as an unknown option, the installed TypeScript is
older than 5.7 — install `typescript@^5.9` before continuing.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example src/config.ts test/config.test.ts
git commit -m "feat: project scaffold and environment configuration"
```

---

## Task 2: Error normalisation

This is the highest-value module in the project. SmartBill reports failure five different ways,
and one of them is an HTTP 200.

**Files:**
- Create: `src/errors.ts`
- Test: `test/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type SmartBillError = {
    message: string;
    code?: string;
    type?: string;
    param?: string;
    httpStatus: number;
    details?: unknown[];
    hint?: string;
  };
  export function stripHtml(text: string): string;
  export function normalizeError(
    httpStatus: number,
    contentType: string,
    body: unknown,
  ): SmartBillError | null;
  export function networkError(cause: unknown): SmartBillError;
  ```
  `normalizeError` returns `null` when the response is a genuine success.

- [ ] **Step 1: Write the failing test**

`test/errors.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeError, stripHtml, networkError } from '../src/errors.ts';

const JSON_CT = 'application/json';

test('a 200 with an empty errorText is success', () => {
  assert.equal(normalizeError(200, JSON_CT, { errorText: '', number: '3593' }), null);
});

test('a 200 with a non-empty errorText is a failure', () => {
  const err = normalizeError(200, JSON_CT, {
    errorText: 'Seria nu a fost gasita! Folositi o serie creata in contul de cloud.',
    documentId: -1,
  });
  assert.ok(err);
  assert.equal(err.httpStatus, 200);
  assert.match(err.message, /Seria nu a fost gasita/);
});

test('errorText containing HTML is truncated at the first tag', () => {
  const err = normalizeError(400, JSON_CT, {
    errorText: 'Nu ai facut nicio achizitie pentru produsul Mere.<br/>Verifica stocul.',
  });
  assert.ok(err);
  assert.equal(err.message, 'Nu ai facut nicio achizitie pentru produsul Mere.');
});

test('errorText with a hidden details div keeps only the leading sentence', () => {
  const err = normalizeError(400, JSON_CT, {
    errorText:
      'Unitatea de masura buc a produsului X nu are factor de conversie setat.' +
      '<div id="moreErrorDetails" style="display:none"><p>ajutor</p></div>',
  });
  assert.ok(err);
  assert.equal(
    err.message,
    'Unitatea de masura buc a produsului X nu are factor de conversie setat.',
  );
});

test('V1 invalid_request_error surfaces code and param', () => {
  const err = normalizeError(400, JSON_CT, {
    status: 400,
    type: 'invalid_request_error',
    instance: '/SBORO/api/invoice/v2',
    errors: [
      {
        code: 'json_mapping_error',
        message: 'Unrecognized property: zzz.',
        docUrl: 'https://api.smartbill.ro/#v3-error-invalid_request_error',
        param: 'zzz',
      },
    ],
  });
  assert.ok(err);
  assert.equal(err.code, 'json_mapping_error');
  assert.equal(err.type, 'invalid_request_error');
  assert.equal(err.param, 'zzz');
  assert.match(err.message, /Unrecognized property/);
});

test('a V3 body with two errors surfaces both', () => {
  const err = normalizeError(400, JSON_CT, {
    status: 400,
    type: 'validation_error',
    instance: '/api/v3/clients',
    errors: [
      { code: 'missing_required_field', message: 'must not be blank', param: 'name' },
      { code: 'invalid_field_format', message: 'must be a well-formed email address', param: 'email' },
    ],
  });
  assert.ok(err);
  assert.equal(err.code, 'missing_required_field');
  assert.equal(err.param, 'name');
  assert.equal(err.details?.length, 2);
  assert.match(err.message, /must not be blank/);
});

test('an HTML 500 is reported as a probable field-name typo, not a server fault', () => {
  const err = normalizeError(500, 'text/html;charset=utf-8', '<html><body>error</body></html>');
  assert.ok(err);
  assert.equal(err.httpStatus, 500);
  assert.match(err.hint ?? '', /field name/i);
});

test('a 4xx with no recognisable body still produces an error', () => {
  const err = normalizeError(404, JSON_CT, {});
  assert.ok(err);
  assert.equal(err.httpStatus, 404);
});

test('a 2xx with no errorText and no error envelope is success', () => {
  assert.equal(normalizeError(200, JSON_CT, { list: [{ name: 'fac' }] }), null);
});

test('stripHtml keeps text before the first tag and collapses whitespace', () => {
  assert.equal(stripHtml('  Cauza reala.  <b>x</b> rest'), 'Cauza reala.');
  assert.equal(stripHtml('fara marcaje'), 'fara marcaje');
});

test('networkError reports httpStatus 0', () => {
  const err = networkError(new Error('ECONNREFUSED'));
  assert.equal(err.httpStatus, 0);
  assert.match(err.message, /ECONNREFUSED/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/errors.test.ts`
Expected: FAIL — cannot resolve `../src/errors.ts`.

- [ ] **Step 3: Write `src/errors.ts`**

```ts
export type SmartBillError = {
  /** Human-readable cause, HTML stripped. */
  message: string;
  /** Stable machine code, e.g. json_mapping_error, missing_required_field. */
  code?: string;
  /** Error category, e.g. invalid_request_error, validation_error. */
  type?: string;
  /** The offending field, e.g. products[0].quantity. */
  param?: string;
  /** 0 when the request never reached the server. */
  httpStatus: number;
  /** Every element of a V3 errors[] array, when there is more than one. */
  details?: unknown[];
  /** An actionable next step, where the spec documents one. */
  hint?: string;
};

/**
 * SmartBill's V1 `errorText` can carry HTML markup: `<br/>` before a suggestion, `<b>` around
 * document names, and a hidden `<div id="moreErrorDetails">` block of UI help text. The cause is
 * always the leading sentence, so everything from the first `<` onward is dropped.
 */
export function stripHtml(text: string): string {
  const cut = text.indexOf('<');
  const head = cut === -1 ? text : text.slice(0, cut);
  return head.replace(/\s+/g, ' ').trim();
}

type ProblemItem = { code?: string; message?: string; param?: string; docUrl?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Collapses every SmartBill failure shape into one error, or returns null for a success.
 *
 * The critical rule: on API V1 an HTTP 200 is NOT proof of success. `errorText` is the source of
 * truth — empty means the operation succeeded, non-empty carries the reason it did not.
 */
export function normalizeError(
  httpStatus: number,
  contentType: string,
  body: unknown,
): SmartBillError | null {
  // An HTML body means the request never reached the JSON layer. Per the SmartBill docs a 500
  // with an HTML body is almost always a misspelled field name, not a real server fault.
  if (contentType.includes('text/html')) {
    return {
      message:
        httpStatus === 500
          ? 'SmartBill returned an HTML error page.'
          : `SmartBill returned an HTML response (HTTP ${httpStatus}).`,
      httpStatus,
      hint: 'This usually means a field name in the request body is misspelled. Check every field name against the OpenAPI schema before retrying.',
    };
  }

  if (isRecord(body)) {
    // Shape 1: the classic V1 business failure. Checked before the status code, because it is
    // the only failure that can arrive with HTTP 200.
    const errorText = body.errorText;
    if (typeof errorText === 'string' && errorText.trim() !== '') {
      return { message: stripHtml(errorText), httpStatus };
    }

    // Shape 2 and 3: the V1 invalid_request_error envelope and the V3 problem envelope. Same
    // structure, so the same branch handles both.
    const errors = body.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = (errors[0] ?? {}) as ProblemItem;
      return {
        message: first.message ?? `Request failed with HTTP ${httpStatus}.`,
        code: first.code,
        type: typeof body.type === 'string' ? body.type : undefined,
        param: first.param,
        httpStatus,
        details: errors,
      };
    }
  }

  // No recognisable error envelope: trust the status code.
  if (httpStatus >= 400) {
    return { message: `Request failed with HTTP ${httpStatus}.`, httpStatus };
  }

  return null;
}

export function networkError(cause: unknown): SmartBillError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    message: `Could not reach SmartBill: ${message}`,
    httpStatus: 0,
    hint: 'Check network connectivity and SMARTBILL_BASE_URL.',
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/errors.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "feat: normalise SmartBill's five failure shapes into one error type"
```

---

## Task 3: Rate-limit sliding window

A V1 breach blocks the token for **10 minutes**, so this delays rather than sends.

**Files:**
- Create: `src/ratelimit.ts`
- Test: `test/ratelimit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
  export class SlidingWindow {
    constructor(max: number, windowMs: number, clock?: Clock);
    acquire(): Promise<void>;
  }
  export const realClock: Clock;
  ```

- [ ] **Step 1: Write the failing test**

`test/ratelimit.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindow, type Clock } from '../src/ratelimit.ts';

/** A clock whose time only moves when a sleep is awaited. */
function fakeClock(): Clock & { slept: number[]; time: number } {
  const c = {
    time: 1_000_000,
    slept: [] as number[],
    now: () => c.time,
    sleep: async (ms: number) => {
      c.slept.push(ms);
      c.time += ms;
    },
  };
  return c;
}

test('lets the first `max` calls through without sleeping', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(3, 10_000, clock);
  await w.acquire();
  await w.acquire();
  await w.acquire();
  assert.deepEqual(clock.slept, []);
});

test('delays the call that would breach the window', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(3, 10_000, clock);
  for (let i = 0; i < 3; i += 1) await w.acquire();
  await w.acquire();
  assert.equal(clock.slept.length, 1);
  assert.ok(clock.slept[0]! > 0 && clock.slept[0]! <= 10_000);
});

test('does not delay once the window has rolled past', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(3, 10_000, clock);
  for (let i = 0; i < 3; i += 1) await w.acquire();
  clock.time += 10_001;
  await w.acquire();
  assert.deepEqual(clock.slept, []);
});

test('the V1 window delays the 31st call in 10 seconds', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(30, 10_000, clock);
  for (let i = 0; i < 30; i += 1) await w.acquire();
  assert.deepEqual(clock.slept, []);
  await w.acquire();
  assert.equal(clock.slept.length, 1);
});

test('the V3 window delays the 61st call in 10 seconds', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(60, 10_000, clock);
  for (let i = 0; i < 60; i += 1) await w.acquire();
  assert.deepEqual(clock.slept, []);
  await w.acquire();
  assert.equal(clock.slept.length, 1);
});

test('serialises concurrent acquires so the window is never oversubscribed', async () => {
  const clock = fakeClock();
  const w = new SlidingWindow(2, 10_000, clock);
  await Promise.all([w.acquire(), w.acquire(), w.acquire(), w.acquire()]);
  // Four calls through a window of two means exactly two of them had to wait.
  assert.equal(clock.slept.length, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/ratelimit.test.ts`
Expected: FAIL — cannot resolve `../src/ratelimit.ts`.

- [ ] **Step 3: Write `src/ratelimit.ts`**

```ts
export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A sliding-window limiter that delays rather than rejects.
 *
 * SmartBill V1 blocks a token for ten minutes when it exceeds 30 requests in 10 seconds, which a
 * model iterating over documents can trip trivially. Waiting a few hundred milliseconds is always
 * cheaper than losing the token for ten minutes.
 *
 * ponytail: one shared window per API version; per-endpoint windows only if SmartBill ever
 * publishes per-endpoint limits.
 */
export class SlidingWindow {
  #max: number;
  #windowMs: number;
  #clock: Clock;
  #hits: number[] = [];
  /** Serialises acquires so concurrent callers cannot all read a stale window. */
  #queue: Promise<void> = Promise.resolve();

  constructor(max: number, windowMs: number, clock: Clock = realClock) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#clock = clock;
  }

  async acquire(): Promise<void> {
    const next = this.#queue.then(() => this.#reserve());
    // Keep the chain alive even if a reservation rejects.
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #reserve(): Promise<void> {
    this.#evict();
    if (this.#hits.length >= this.#max) {
      const oldest = this.#hits[0]!;
      const waitMs = oldest + this.#windowMs - this.#clock.now();
      if (waitMs > 0) await this.#clock.sleep(waitMs);
      this.#evict();
    }
    this.#hits.push(this.#clock.now());
  }

  #evict(): void {
    const cutoff = this.#clock.now() - this.#windowMs;
    while (this.#hits.length > 0 && this.#hits[0]! <= cutoff) this.#hits.shift();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/ratelimit.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ratelimit.ts test/ratelimit.test.ts
git commit -m "feat: sliding-window rate limiter that delays instead of tripping the V1 lockout"
```

---

## Task 4: HTTP client

**Files:**
- Create: `src/client.ts`
- Test: `test/client.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1), `SmartBillError`/`normalizeError`/`networkError` (Task 2), `SlidingWindow`/`Clock` (Task 3).
- Produces:
  ```ts
  export type ApiVersion = 'v1' | 'v3';
  export type QueryValue = string | number | boolean | undefined | null;
  export type RequestSpec = {
    api: ApiVersion;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;                              // e.g. '/invoice/pdf' or '/v3/companies/RO123/clients'
    query?: Record<string, QueryValue>;
    body?: unknown;
    binary?: boolean;                          // expect application/octet-stream on success
  };
  export type RateLimit = {
    limit?: number; remaining?: number; reset?: number;
    dailyLimit?: number; dailyRemaining?: number; dailyReset?: number;
    retryAfter?: number;
  };
  export type ClientResult =
    | { ok: true; data: unknown; bytes?: Uint8Array; status: number; rateLimit: RateLimit }
    | { ok: false; error: SmartBillError; status: number; rateLimit: RateLimit };
  export class SmartBillClient {
    constructor(config: Config, deps?: { fetchImpl?: typeof fetch; clock?: Clock });
    request(spec: RequestSpec): Promise<ClientResult>;
  }
  ```

- [ ] **Step 1: Write the failing test**

`test/client.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartBillClient } from '../src/client.ts';
import type { Clock } from '../src/ratelimit.ts';
import { loadConfig } from '../src/config.ts';

const config = loadConfig({
  SMARTBILL_EMAIL: 'a@b.co',
  SMARTBILL_TOKEN: 'tok',
  SMARTBILL_V3_TOKEN: 'sb_live_x',
  SMARTBILL_BASE_URL: 'https://api.test/SBORO/api',
});

const noWaitClock: Clock = { now: () => Date.now(), sleep: async () => {} };

type Call = { url: string; init: RequestInit };

/** Returns a fetch stub plus the list of calls it received. */
function stubFetch(...responses: Response[]) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return r.clone();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const client = (f: typeof fetch) =>
  new SmartBillClient(config, { fetchImpl: f, clock: noWaitClock });

test('v1 uses Basic auth with base64 email:token', async () => {
  const { impl, calls } = stubFetch(json({ errorText: '' }));
  await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  const auth = new Headers(calls[0]!.init.headers).get('authorization');
  assert.equal(auth, `Basic ${Buffer.from('a@b.co:tok').toString('base64')}`);
});

test('v3 uses Bearer auth', async () => {
  const { impl, calls } = stubFetch(json({ items: [], pagination: {} }));
  await client(impl).request({ api: 'v3', method: 'GET', path: '/v3/companies/RO1/clients' });
  const auth = new Headers(calls[0]!.init.headers).get('authorization');
  assert.equal(auth, 'Bearer sb_live_x');
});

test('builds the query string and drops undefined and null', async () => {
  const { impl, calls } = stubFetch(json({ errorText: '' }));
  await client(impl).request({
    api: 'v1',
    method: 'GET',
    path: '/stocks',
    query: { cif: 'RO1', date: '2026-07-11', warehouseName: undefined, productCode: null, limit: 5, flag: true },
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/SBORO/api/stocks');
  assert.equal(url.searchParams.get('cif'), 'RO1');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('flag'), 'true');
  assert.equal(url.searchParams.has('warehouseName'), false);
  assert.equal(url.searchParams.has('productCode'), false);
});

test('sends Content-Type only when there is a body', async () => {
  const { impl, calls } = stubFetch(json({ errorText: '' }));
  const c = client(impl);
  await c.request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(new Headers(calls[0]!.init.headers).get('content-type'), null);

  await c.request({ api: 'v1', method: 'POST', path: '/invoice/v2', body: { companyVatCode: 'RO1' } });
  assert.equal(new Headers(calls[1]!.init.headers).get('content-type'), 'application/json');
  assert.equal(calls[1]!.init.body, JSON.stringify({ companyVatCode: 'RO1' }));
});

test('a 200 carrying errorText is returned as a failure', async () => {
  const { impl } = stubFetch(json({ errorText: 'Seria nu a fost gasita!', documentId: -1 }));
  const res = await client(impl).request({ api: 'v1', method: 'POST', path: '/invoice/v2', body: {} });
  assert.equal(res.ok, false);
  assert.equal(res.status, 200);
  if (!res.ok) assert.match(res.error.message, /Seria nu a fost gasita/);
});

test('parses rate-limit headers', async () => {
  const { impl } = stubFetch(
    json({ errorText: '' }, 200, {
      'x-ratelimit-limit': '30',
      'x-ratelimit-remaining': '29',
      'x-ratelimit-reset': '1790000000',
      'x-ratelimit-daily-limit': '50000',
      'x-ratelimit-daily-remaining': '49999',
    }),
  );
  const res = await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(res.rateLimit.limit, 30);
  assert.equal(res.rateLimit.remaining, 29);
  assert.equal(res.rateLimit.reset, 1790000000);
  assert.equal(res.rateLimit.dailyLimit, 50000);
});

test('binary responses come back as bytes', async () => {
  const pdf = new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
  const { impl } = stubFetch(pdf);
  const res = await client(impl).request({
    api: 'v1', method: 'GET', path: '/invoice/pdf', query: { cif: 'RO1' }, binary: true,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.bytes?.length, 4);
    assert.equal(Buffer.from(res.bytes!).toString('latin1'), '%PDF');
  }
});

test('a binary endpoint that returns JSON is decoded as an error', async () => {
  const { impl } = stubFetch(json({ errorText: 'Numarul facturii trebuie specificat' }, 400));
  const res = await client(impl).request({
    api: 'v1', method: 'GET', path: '/invoice/pdf', query: { cif: 'RO1' }, binary: true,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error.message, /Numarul facturii/);
});

test('an HTML 500 becomes the field-name hint', async () => {
  const { impl } = stubFetch(
    new Response('<html>500</html>', { status: 500, headers: { 'content-type': 'text/html' } }),
  );
  const res = await client(impl).request({ api: 'v1', method: 'POST', path: '/invoice/v2', body: {} });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error.hint ?? '', /field name/i);
});

test('a 429 with Retry-After is retried exactly once', async () => {
  const { impl, calls } = stubFetch(
    json({ status: 429, type: 'invalid_request_error', errors: [{ code: 'rate_limit_exceeded', message: 'slow down' }] }, 429, { 'retry-after': '2' }),
    json({ errorText: '', number: '1' }),
  );
  const res = await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(calls.length, 2);
  assert.equal(res.ok, true);
});

test('a Retry-After above the ceiling errors instead of sleeping', async () => {
  const { impl, calls } = stubFetch(
    json({ status: 429, type: 'invalid_request_error', errors: [{ code: 'rate_limit_exceeded', message: 'blocked' }] }, 429, { 'retry-after': '600' }),
  );
  const res = await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(calls.length, 1);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.code, 'rate_limit_exceeded');
    assert.match(res.error.hint ?? '', /600/);
  }
});

test('a 400 is never retried', async () => {
  const { impl, calls } = stubFetch(json({ errorText: 'bad' }, 400));
  await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(calls.length, 1);
});

test('a fetch rejection becomes a status-0 error', async () => {
  const impl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const res = await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.httpStatus, 0);
});

test('missing credentials fail before any HTTP call', async () => {
  const bare = loadConfig({});
  const { impl, calls } = stubFetch(json({ errorText: '' }));
  const res = await new SmartBillClient(bare, { fetchImpl: impl, clock: noWaitClock }).request({
    api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' },
  });
  assert.equal(calls.length, 0);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error.message, /SMARTBILL_EMAIL/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/client.test.ts`
Expected: FAIL — cannot resolve `../src/client.ts`.

- [ ] **Step 3: Write `src/client.ts`**

```ts
import type { Config } from './config.ts';
import { networkError, normalizeError, type SmartBillError } from './errors.ts';
import { realClock, SlidingWindow, type Clock } from './ratelimit.ts';

export type ApiVersion = 'v1' | 'v3';
export type QueryValue = string | number | boolean | undefined | null;

export type RequestSpec = {
  api: ApiVersion;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path below the base URL, leading slash included. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** True when a successful response is a binary document rather than JSON. */
  binary?: boolean;
};

export type RateLimit = {
  limit?: number;
  remaining?: number;
  reset?: number;
  dailyLimit?: number;
  dailyRemaining?: number;
  dailyReset?: number;
  retryAfter?: number;
};

export type ClientResult =
  | { ok: true; data: unknown; bytes?: Uint8Array; status: number; rateLimit: RateLimit }
  | { ok: false; error: SmartBillError; status: number; rateLimit: RateLimit };

/**
 * A Retry-After longer than this is reported rather than slept through: SmartBill's penalty
 * intervals escalate to 600 seconds, and no MCP tool call should hang for ten minutes.
 */
const MAX_RETRY_AFTER_SECONDS = 60;

const num = (raw: string | null): number | undefined => {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

function readRateLimit(headers: Headers): RateLimit {
  return {
    limit: num(headers.get('x-ratelimit-limit')),
    remaining: num(headers.get('x-ratelimit-remaining')),
    reset: num(headers.get('x-ratelimit-reset')),
    dailyLimit: num(headers.get('x-ratelimit-daily-limit')),
    dailyRemaining: num(headers.get('x-ratelimit-daily-remaining')),
    dailyReset: num(headers.get('x-ratelimit-daily-reset')),
    retryAfter: num(headers.get('retry-after')),
  };
}

export class SmartBillClient {
  #config: Config;
  #fetch: typeof fetch;
  #clock: Clock;
  // V1: 30 requests / 10s, breach costs a 10-minute lockout.
  // V3: 60 reads / 10s. Every V3 operation in the spec is a read, so no write window is needed.
  #windows: Record<ApiVersion, SlidingWindow>;

  constructor(config: Config, deps: { fetchImpl?: typeof fetch; clock?: Clock } = {}) {
    this.#config = config;
    this.#fetch = deps.fetchImpl ?? globalThis.fetch;
    this.#clock = deps.clock ?? realClock;
    this.#windows = {
      v1: new SlidingWindow(30, 10_000, this.#clock),
      v3: new SlidingWindow(60, 10_000, this.#clock),
    };
  }

  async request(spec: RequestSpec): Promise<ClientResult> {
    const authHeader = this.#authorization(spec.api);
    if (typeof authHeader !== 'string') {
      return { ok: false, error: authHeader, status: 0, rateLimit: {} };
    }

    const url = this.#url(spec);
    const headers: Record<string, string> = {
      authorization: authHeader,
      accept: spec.binary ? 'application/octet-stream, application/json' : 'application/json',
    };
    const init: RequestInit = { method: spec.method, headers };
    if (spec.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(spec.body);
    }

    const first = await this.#send(spec.api, url, init);

    // 429 and 503 are the only statuses the SmartBill docs say to retry, and only when
    // Retry-After says how long to wait.
    if (first.ok || (first.status !== 429 && first.status !== 503)) return first;

    const wait = first.rateLimit.retryAfter;
    if (wait === undefined) return first;

    if (wait > MAX_RETRY_AFTER_SECONDS) {
      return {
        ...first,
        error: {
          ...first.error,
          hint: `SmartBill asked for a ${wait}-second wait, which is longer than this server will hold a call open. Retry after ${wait} seconds; reduce the request rate to avoid the penalty escalating further.`,
        },
      };
    }

    await this.#clock.sleep(wait * 1000);
    return this.#send(spec.api, url, init);
  }

  async #send(api: ApiVersion, url: string, init: RequestInit): Promise<ClientResult> {
    await this.#windows[api].acquire();

    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (cause) {
      return { ok: false, error: networkError(cause), status: 0, rateLimit: {} };
    }

    const rateLimit = readRateLimit(response.headers);
    const contentType = response.headers.get('content-type') ?? '';
    const status = response.status;

    // Decode by what actually came back, not by what was expected: the PDF endpoints return
    // JSON when they fail.
    if (contentType.includes('application/json')) {
      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        return { ok: false, error: networkError(cause), status, rateLimit };
      }
      const error = normalizeError(status, contentType, body);
      return error
        ? { ok: false, error, status, rateLimit }
        : { ok: true, data: body, status, rateLimit };
    }

    if (contentType.includes('text/html')) {
      const text = await response.text();
      const error = normalizeError(status, contentType, text);
      return { ok: false, error: error ?? { message: text.slice(0, 200), httpStatus: status }, status, rateLimit };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (status >= 400) {
      return {
        ok: false,
        error: { message: `Request failed with HTTP ${status}.`, httpStatus: status },
        status,
        rateLimit,
      };
    }
    return { ok: true, data: undefined, bytes, status, rateLimit };
  }

  /** Returns the header value, or the error explaining which variables are missing. */
  #authorization(api: ApiVersion): string | SmartBillError {
    if (api === 'v1') {
      if (!this.#config.hasV1) {
        return {
          message: 'API V1 credentials are not configured. Set SMARTBILL_EMAIL and SMARTBILL_TOKEN.',
          httpStatus: 0,
          hint: 'Both values are on https://cloud.smartbill.ro/core/integrari/ under API.',
        };
      }
      const basic = Buffer.from(`${this.#config.email}:${this.#config.token}`).toString('base64');
      return `Basic ${basic}`;
    }
    if (!this.#config.hasV3) {
      return {
        message: 'API V3 credentials are not configured. Set SMARTBILL_V3_TOKEN.',
        httpStatus: 0,
        hint: 'Generate a V3 bearer token on https://cloud.smartbill.ro/core/integrari/.',
      };
    }
    return `Bearer ${this.#config.v3Token}`;
  }

  #url(spec: RequestSpec): string {
    const url = new URL(this.#config.baseUrl + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/client.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the whole suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: all tests pass; typecheck silent.

- [ ] **Step 6: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "feat: HTTP client with per-version auth, content-type dispatch and bounded retry"
```

---

## Task 5: Request schemas

zod mirrors of the spec's `components.schemas`, shared by the tool modules.

**Files:**
- Create: `src/schemas.ts`
- Test: `test/schemas.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `currencyEnum`, `languageEnum`, `paymentTypeEnum`, `invoicePaymentTypeEnum`, `deletablePaymentTypeEnum`, `clientSchema`, `productSchema`, `invoicePaymentSchema`, `emailRecipientsSchema`, `invoiceRequestSchema`, `estimateRequestSchema`, `paymentRequestSchema`, `sendEmailRequestSchema`, `documentRefSchema`, `paginationSchema` — all `z.ZodType` values.

- [ ] **Step 1: Write `src/schemas.ts`**

Enum members are copied verbatim from the spec. Every optional field is `.optional()`;
`companyVatCode` is deliberately absent from the request schemas because tools take `cif` and the
tool layer injects it.

```ts
import * as z from 'zod';

export const currencyEnum = z.enum([
  'RON', 'EUR', 'USD', 'GBP', 'CAD', 'AUD', 'CHF', 'TRY', 'CZK', 'DKK', 'HUF',
  'MDL', 'SEK', 'NOK', 'JPY', 'EGP', 'PLN', 'RUB', 'AED', 'BRL', 'CNY', 'HRK',
  'INR', 'KRW', 'MXN', 'NZD', 'RSD', 'THB', 'UAH', 'XDR', 'ZAR',
]);

export const languageEnum = z.enum(['RO', 'EN', 'DE', 'FR', 'IT', 'ES']);

/** Accepted by POST /payment. */
export const paymentTypeEnum = z.enum([
  'Card', 'Card online', 'Chitanta', 'Bon', 'Ordin plata', 'CEC', 'Bilet ordin',
  'Mandat postal', 'Extras de cont', 'Ramburs', 'Alta incasare',
]);

/** Accepted inside an invoice's `payment` object. */
export const invoicePaymentTypeEnum = z.enum([
  'Chitanta', 'Bon', 'Card', 'Card online', 'CEC', 'Bilet ordin', 'Ordin plata',
  'Mandat postal', 'Extras de cont', 'Ramburs', 'Alta incasare',
]);

/** Accepted by DELETE /payment/v2 — excludes Chitanta and Bon fiscal by design. */
export const deletablePaymentTypeEnum = z.enum([
  'Card', 'Card online', 'CEC', 'Bilet ordin', 'Ordin plata', 'Mandat postal',
  'Extras de cont', 'Ramburs', 'Alta incasare',
]);

export const clientSchema = z.object({
  name: z.string().describe('Client name. Required.'),
  country: z.string().describe('Country, e.g. "Romania". Required.'),
  vatCode: z.string().optional().describe('Client CIF/VAT code.'),
  isTaxPayer: z.boolean().optional().describe('True if the client is VAT-registered.'),
  regCom: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  county: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  contact: z.string().optional(),
  iban: z.string().optional(),
  bank: z.string().optional(),
  code: z.string().optional().describe('Your internal client code.'),
  saveToDb: z.boolean().optional().describe('Save this client to the SmartBill client list.'),
});

export const productSchema = z.object({
  name: z.string().describe('Product name. Required.'),
  quantity: z.number().describe('Quantity. Required.'),
  price: z.number().describe(
    'Unit price. EXCLUDES VAT unless isTaxIncluded is true — this is the most common source of wrong totals.',
  ),
  measuringUnitName: z.string().describe(
    'Unit of measure, e.g. "buc". Must match a unit configured in the SmartBill account exactly.',
  ),
  taxPercentage: z.number().describe('VAT percentage as a bare number, e.g. 21. Never "21%".'),
  code: z.string().optional().describe('SKU. Required when useStock is true.'),
  productDescription: z.string().optional(),
  isService: z.boolean().optional(),
  currency: currencyEnum.optional(),
  exchangeRate: z.number().optional(),
  isTaxIncluded: z.boolean().optional().describe('Defaults to false: price is treated as ex-VAT.'),
  taxName: z.string().optional().describe(
    'VAT rate name, e.g. "Normala". Must match a rate configured in the account — read it from smartbill_get_tax_and_series.',
  ),
  warehouseName: z.string().optional().describe('Warehouse name. Case-sensitive.'),
  isDiscount: z.boolean().optional(),
  numberOfItems: z.number().int().optional().describe('How many preceding lines the discount applies to.'),
  discountType: z.union([z.literal(1), z.literal(2)]).optional().describe('1 = percentage, 2 = fixed value.'),
  discountValue: z.number().optional(),
  discountPercentage: z.number().optional(),
  translatedName: z.string().optional(),
  translatedMeasuringUnit: z.string().optional(),
  saveToDb: z.boolean().optional(),
  useSBProductName: z.boolean().optional(),
});

export const invoicePaymentSchema = z.object({
  value: z.number().optional(),
  paymentSeries: z.string().optional().describe('Receipt series, required when type is "Chitanta".'),
  type: invoicePaymentTypeEnum.optional(),
  isCash: z.boolean().optional(),
});

export const emailRecipientsSchema = z.object({
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
});

/** Fields shared by POST /invoice/v2 and POST /estimate/v2. */
const documentBase = {
  seriesName: z.string().describe(
    'Document series name. Must match a series configured in the SmartBill account — read it from smartbill_get_series. Do not invent one.',
  ),
  client: clientSchema,
  products: z.array(productSchema).min(1),
  issueDate: z.string().optional().describe('yyyy-MM-dd. Defaults to today.'),
  dueDate: z.string().optional().describe('yyyy-MM-dd.'),
  isDraft: z.boolean().optional(),
  currency: currencyEnum.optional(),
  exchangeRate: z.number().optional(),
  precision: z.number().int().optional(),
  paymentUrl: z.string().optional().describe('Set to "Generate URL" to get a payment link in the response `url` field.'),
  sendEmail: z.boolean().optional(),
  email: emailRecipientsSchema.optional(),
  observations: z.string().optional(),
  mentions: z.string().optional(),
  issuerName: z.string().optional(),
  issuerCnp: z.string().optional(),
  delegateName: z.string().optional(),
  delegateIdentityCard: z.string().optional(),
  delegateAuto: z.string().optional(),
  useIntraCif: z.boolean().optional(),
  aviz: z.string().optional(),
};

export const invoiceRequestSchema = z.object({
  ...documentBase,
  language: languageEnum.optional(),
  useStock: z.boolean().optional().describe('Discharge stock. Every product then needs a `code`.'),
  payment: invoicePaymentSchema.optional(),
  paymentDate: z.string().optional(),
  deliveryDate: z.string().optional(),
  usePaymentTax: z.boolean().optional().describe('VAT on collection (TVA la incasare).'),
  paymentBase: z.number().optional(),
  colectedTax: z.number().optional(),
  paymentTotal: z.number().optional(),
  useEstimateDetails: z.boolean().optional().describe('Copy the products from a proforma named in `estimate`.'),
  estimate: z
    .object({ seriesName: z.string(), number: z.string() })
    .optional()
    .describe('The proforma to invoice, when useEstimateDetails is true.'),
});

export const estimateRequestSchema = z.object({
  ...documentBase,
  language: z.string().optional(),
});

export const paymentRequestSchema = z.object({
  type: paymentTypeEnum,
  issueDate: z.string().optional().describe('yyyy-MM-dd.'),
  isDraft: z.boolean().optional(),
  seriesName: z.string().optional().describe('Receipt series, required when type is "Chitanta".'),
  number: z.string().optional(),
  returnFiscalPrinterText: z.boolean().optional(),
  observation: z.string().optional(),
  useStock: z.boolean().optional(),
  client: clientSchema.optional(),
  products: z.array(productSchema).optional(),
  value: z.number().optional(),
  currency: currencyEnum.optional(),
  exchangeRate: z.number().optional(),
  precision: z.number().int().optional(),
  isCash: z.boolean().optional(),
  receivedCash: z.number().optional(),
  receivedCard: z.number().optional(),
  receivedTicheteMasa: z.number().optional(),
  receivedTicheteCadou: z.number().optional(),
  receivedOrdinDePlata: z.number().optional(),
  receivedCec: z.number().optional(),
  receivedCredit: z.number().optional(),
  receivedCupon: z.number().optional(),
  receivedPuncteDeFidelitate: z.number().optional(),
  receivedBonuriValoareFixa: z.number().optional(),
  receivedMonedaAlternativa: z.number().optional(),
  text: z.string().optional(),
  translatedText: z.string().optional(),
  language: z.string().optional(),
  useInvoiceDetails: z.boolean().optional().describe('Take the client and products from the invoices in invoicesList.'),
  invoicesList: z
    .array(z.object({ seriesName: z.string(), number: z.string() }))
    .optional()
    .describe('Invoices this payment settles.'),
});

export const sendEmailRequestSchema = z.object({
  seriesName: z.string(),
  number: z.string(),
  type: z.enum(['factura', 'proforma']),
  to: z.string().optional().describe('Defaults to the client email on record.'),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  bodyText: z.string().optional(),
});

/** The series + number pair that identifies a V1 document. */
export const documentRefSchema = z.object({
  seriesname: z.string().describe('Document series name.'),
  number: z.string().describe('Document number.'),
});

/** V3 cursor pagination. */
export const paginationSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('1-100, default 20.'),
  after: z.string().optional().describe('Cursor id to continue after. Mutually exclusive with `before`.'),
  before: z.string().optional().describe('Cursor id to continue before. Mutually exclusive with `after`.'),
});
```

- [ ] **Step 2: Write the test**

`test/schemas.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  invoiceRequestSchema,
  productSchema,
  paginationSchema,
  deletablePaymentTypeEnum,
} from '../src/schemas.ts';

test('a minimal invoice passes validation', () => {
  const parsed = invoiceRequestSchema.safeParse({
    seriesName: 'fac',
    client: { name: 'Client Test SRL', country: 'Romania' },
    products: [
      { name: 'Produs', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21 },
    ],
  });
  assert.equal(parsed.success, true);
});

test('an invoice with no products is rejected', () => {
  const parsed = invoiceRequestSchema.safeParse({
    seriesName: 'fac',
    client: { name: 'X', country: 'Romania' },
    products: [],
  });
  assert.equal(parsed.success, false);
});

test('taxPercentage must be a number, not a percentage string', () => {
  const parsed = productSchema.safeParse({
    name: 'P', quantity: 1, price: 10, measuringUnitName: 'buc', taxPercentage: '21%',
  });
  assert.equal(parsed.success, false);
});

test('pagination limit is bounded to 1-100', () => {
  assert.equal(paginationSchema.safeParse({ limit: 100 }).success, true);
  assert.equal(paginationSchema.safeParse({ limit: 0 }).success, false);
  assert.equal(paginationSchema.safeParse({ limit: 101 }).success, false);
});

test('Chitanta is not a deletable payment type', () => {
  assert.equal(deletablePaymentTypeEnum.safeParse('Chitanta').success, false);
  assert.equal(deletablePaymentTypeEnum.safeParse('Ordin plata').success, true);
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test test/schemas.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 4: Commit**

```bash
git add src/schemas.ts test/schemas.test.ts
git commit -m "feat: zod request schemas mirroring the OpenAPI components"
```

---

## Task 6: Tool plumbing, entrypoint, and the invoice tools

This task proves the whole pipeline end to end: a `ToolDef`, the shared helpers, the registration
loop, and a real MCP round-trip.

**Files:**
- Create: `src/tools/shared.ts`, `src/tools/invoices.ts`, `src/tools/index.ts`, `src/index.ts`
- Test: `test/shared.test.ts`, `test/invoices.test.ts`

**Interfaces:**
- Consumes: `SmartBillClient`, `ClientResult` (Task 4); `Config` (Task 1); schemas (Task 5).
- Produces:
  ```ts
  // src/tools/shared.ts
  export type ToolDef = {
    name: string;
    operationId: string;         // matches the spec, for coverage.test.ts
    api: 'v1' | 'v3';
    title: string;
    description: string;
    inputSchema: z.ZodObject<z.ZodRawShape>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
    run: (ctx: ToolContext, args: any) => Promise<ClientResult | ToolOutcome>;
  };
  export type ToolContext = { client: SmartBillClient; config: Config };
  export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: SmartBillError };
  export function resolveCif(config: Config, cif?: string): string | SmartBillError;
  export function toCallToolResult(outcome: ClientResult | ToolOutcome): CallToolResult;
  export function savePdf(dir: string, filename: string, bytes: Uint8Array): Promise<{ path: string; bytes: number }>;

  // src/tools/index.ts
  export const allTools: ToolDef[];
  ```

- [ ] **Step 1: Write `src/tools/shared.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import type { ClientResult, SmartBillClient } from '../client.ts';
import type { Config } from '../config.ts';
import type { SmartBillError } from '../errors.ts';

export type ToolContext = { client: SmartBillClient; config: Config };

export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: SmartBillError };

export type ToolAnnotationHints = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
};

export type ToolDef = {
  /** MCP tool name, always smartbill_-prefixed. */
  name: string;
  /** The matching operationId in docs/smartbill-openapi-spec.json. */
  operationId: string;
  api: 'v1' | 'v3';
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations?: ToolAnnotationHints;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ClientResult | ToolOutcome>;
};

/** The `cif` argument shared by every tool. */
export const cifArg = z
  .string()
  .optional()
  .describe('Company VAT code (CIF). Defaults to the SMARTBILL_CIF environment variable.');

export function resolveCif(config: Config, cif?: string): string | SmartBillError {
  const resolved = cif?.trim() || config.cif;
  if (!resolved) {
    return {
      message: 'No company VAT code available.',
      httpStatus: 0,
      hint: 'Pass `cif` on the tool call, or set SMARTBILL_CIF in the server environment.',
    };
  }
  return resolved;
}

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Renders an error so the model can act on it without re-reading the docs. */
function renderError(error: SmartBillError): string {
  const lines = [`SmartBill error: ${error.message}`];
  if (error.code) lines.push(`code: ${error.code}`);
  if (error.type) lines.push(`type: ${error.type}`);
  if (error.param) lines.push(`field: ${error.param}`);
  if (error.httpStatus) lines.push(`http: ${error.httpStatus}`);
  if (error.details && error.details.length > 1) {
    lines.push(`all errors: ${JSON.stringify(error.details)}`);
  }
  if (error.hint) lines.push(`hint: ${error.hint}`);
  return lines.join('\n');
}

export function toCallToolResult(outcome: ClientResult | ToolOutcome): CallToolResult {
  if (!outcome.ok) {
    return { content: [{ type: 'text', text: renderError(outcome.error) }], isError: true };
  }
  const data = outcome.data ?? {};
  const text = JSON.stringify(data, null, 2);
  const structured =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/** Writes a document to disk and returns its path — PDFs are never inlined into model context. */
export async function savePdf(
  dir: string,
  filename: string,
  bytes: Uint8Array,
): Promise<{ path: string; bytes: number }> {
  await mkdir(dir, { recursive: true });
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = join(dir, safe);
  await writeFile(path, bytes);
  return { path, bytes: bytes.length };
}
```

- [ ] **Step 2: Write the failing test for the helpers**

`test/shared.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { resolveCif, savePdf, toCallToolResult } from '../src/tools/shared.ts';

test('resolveCif prefers the argument over the environment', () => {
  const config = loadConfig({ SMARTBILL_CIF: 'ENV' });
  assert.equal(resolveCif(config, 'ARG'), 'ARG');
});

test('resolveCif falls back to the environment', () => {
  assert.equal(resolveCif(loadConfig({ SMARTBILL_CIF: 'ENV' })), 'ENV');
});

test('resolveCif errors when neither is present, naming both routes', () => {
  const result = resolveCif(loadConfig({}));
  assert.notEqual(typeof result, 'string');
  if (typeof result !== 'string') {
    assert.match(result.hint ?? '', /SMARTBILL_CIF/);
  }
});

test('toCallToolResult marks failures with isError and renders the param', () => {
  const r = toCallToolResult({
    ok: false,
    error: { message: 'bad field', code: 'json_mapping_error', param: 'products[0].quantity', httpStatus: 400 },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /products\[0\]\.quantity/);
  assert.match(r.content[0]!.text, /json_mapping_error/);
});

test('toCallToolResult renders every error of a multi-error response', () => {
  const r = toCallToolResult({
    ok: false,
    error: {
      message: 'must not be blank',
      httpStatus: 400,
      details: [{ param: 'name' }, { param: 'email' }],
    },
  });
  assert.match(r.content[0]!.text, /email/);
});

test('toCallToolResult passes success data through as structuredContent', () => {
  const r = toCallToolResult({ ok: true, data: { number: '3593', series: 'fac' } });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent, { number: '3593', series: 'fac' });
});

test('savePdf writes the bytes and sanitises the filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  const result = await savePdf(dir, 'fac/2026 001.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  assert.equal(result.bytes, 4);
  assert.equal(result.path, join(dir, 'fac_2026_001.pdf'));
  assert.equal((await readFile(result.path)).toString('latin1'), '%PDF');
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `node --test test/shared.test.ts`
Expected: PASS, 7 tests. (Step 1 wrote the implementation, so this run confirms it. If any test
fails, fix `shared.ts` before continuing.)

- [ ] **Step 4: Write `src/tools/invoices.ts`**

```ts
import * as z from 'zod';
import { invoiceRequestSchema } from '../schemas.ts';
import { cifArg, resolveCif, savePdf, type ToolDef } from './shared.ts';

const docRef = {
  cif: cifArg,
  seriesname: z.string().describe('Invoice series name.'),
  number: z.string().describe('Invoice number.'),
};

const ACCOUNT_STRINGS =
  'seriesName, taxName and measuringUnitName must match values configured in the SmartBill account exactly — read them from smartbill_get_series and smartbill_get_tax_and_series rather than guessing.';

export const invoiceTools: ToolDef[] = [
  {
    name: 'smartbill_create_invoice',
    operationId: 'createInvoiceV2',
    api: 'v1',
    title: 'Create invoice',
    description:
      'Issue a new invoice in SmartBill Cloud. ' +
      ACCOUNT_STRINGS +
      ' Product prices EXCLUDE VAT unless isTaxIncluded is true. taxPercentage is a bare number (21), never a string ("21%"). ' +
      'On success the response carries `number`, `series`, `documentId` and `documentViewUrl` — the last is a public PDF link safe to send to the client.',
    inputSchema: z.object({ cif: cifArg, invoice: invoiceRequestSchema }),
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      const invoice = args.invoice as Record<string, unknown>;
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/invoice/v2',
        body: { companyVatCode: cif, ...invoice },
      });
    },
  },
  {
    name: 'smartbill_create_storno_invoice',
    operationId: 'createStornoInvoice',
    api: 'v1',
    title: 'Create storno (reversal) invoice',
    description:
      'Issue a storno invoice that reverses an existing invoice. Identify the original by its series and number. ' +
      'Use this rather than deleting when the original has already been sent to the client or reported.',
    inputSchema: z.object({
      cif: cifArg,
      seriesName: z.string().describe('Series of the ORIGINAL invoice.'),
      number: z.string().describe('Number of the ORIGINAL invoice.'),
      issueDate: z.string().optional().describe('yyyy-MM-dd. Defaults to today.'),
    }),
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/invoice/reverse',
        body: {
          companyVatCode: cif,
          seriesName: args.seriesName,
          number: args.number,
          issueDate: args.issueDate,
        },
      });
    },
  },
  {
    name: 'smartbill_get_invoice_pdf',
    operationId: 'getInvoicePdf',
    api: 'v1',
    title: 'Download invoice PDF',
    description:
      'Download an invoice as PDF. The file is written to the server download directory and the tool returns its path and size — the PDF bytes are never inlined.',
    inputSchema: z.object(docRef),
    annotations: { readOnlyHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      const res = await client.request({
        api: 'v1',
        method: 'GET',
        path: '/invoice/pdf',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
        binary: true,
      });
      if (!res.ok) return res;
      if (!res.bytes) {
        return { ok: false, error: { message: 'SmartBill returned no PDF content.', httpStatus: res.status } };
      }
      const saved = await savePdf(
        config.downloadDir,
        `${args.seriesname}-${args.number}.pdf`,
        res.bytes,
      );
      return { ok: true, data: saved };
    },
  },
  {
    name: 'smartbill_get_invoice_payment_status',
    operationId: 'getInvoicePaymentStatus',
    api: 'v1',
    title: 'Get invoice payment status',
    description:
      'Check how much of an invoice has been paid. Returns invoiceTotalAmount, paidAmount, unpaidAmount and a `paid` flag.',
    inputSchema: z.object(docRef),
    annotations: { readOnlyHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'GET',
        path: '/invoice/paymentstatus',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    },
  },
  {
    name: 'smartbill_cancel_invoice',
    operationId: 'cancelInvoice',
    api: 'v1',
    title: 'Cancel invoice',
    description:
      'Mark an invoice as cancelled. Reversible with smartbill_restore_invoice — this does not delete the document.',
    inputSchema: z.object(docRef),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'PUT',
        path: '/invoice/cancel',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    },
  },
  {
    name: 'smartbill_restore_invoice',
    operationId: 'restoreInvoice',
    api: 'v1',
    title: 'Restore cancelled invoice',
    description: 'Undo smartbill_cancel_invoice, returning the invoice to its active state.',
    inputSchema: z.object(docRef),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'PUT',
        path: '/invoice/restore',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    },
  },
  {
    name: 'smartbill_delete_invoice',
    operationId: 'deleteInvoice',
    api: 'v1',
    title: 'Delete invoice',
    description:
      'Permanently delete an invoice. IRREVERSIBLE. Only the most recent invoice in a series can normally be deleted. ' +
      'For an invoice already sent or reported, issue a storno with smartbill_create_storno_invoice instead.',
    inputSchema: z.object(docRef),
    annotations: { destructiveHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'DELETE',
        path: '/invoice',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    },
  },
];
```

- [ ] **Step 5: Write `src/tools/index.ts`**

```ts
import { invoiceTools } from './invoices.ts';
import type { ToolDef } from './shared.ts';

export const allTools: ToolDef[] = [...invoiceTools];
```

- [ ] **Step 6: Write `src/index.ts`**

```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { SmartBillClient } from './client.ts';
import { loadConfig } from './config.ts';
import { allTools } from './tools/index.ts';
import { toCallToolResult, type ToolContext } from './tools/shared.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SmartBillClient(config);
  const ctx: ToolContext = { client, config };

  const server = new McpServer({ name: 'smartbill', version: '1.0.0' });

  let registered = 0;
  for (const tool of allTools) {
    // A tool whose credentials are absent is not registered, so the model is never offered a
    // call that can only fail. The rest of the server still works.
    if (tool.api === 'v1' && !config.hasV1) continue;
    if (tool.api === 'v3' && !config.hasV3) continue;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args: Record<string, unknown>) => toCallToolResult(await tool.run(ctx, args)),
    );
    registered += 1;
  }

  // stdout is the MCP wire — every diagnostic goes to stderr.
  if (registered === 0) {
    console.error(
      'smartbill-mcp-server: no tools registered. Set SMARTBILL_EMAIL and SMARTBILL_TOKEN for API V1, and/or SMARTBILL_V3_TOKEN for API V3.',
    );
  } else {
    console.error(
      `smartbill-mcp-server: ${registered}/${allTools.length} tools registered (V1 ${config.hasV1 ? 'on' : 'off'}, V3 ${config.hasV3 ? 'on' : 'off'}).`,
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error('smartbill-mcp-server failed to start:', error);
  process.exit(1);
});
```

- [ ] **Step 7: Write the invoice tool test**

`test/invoices.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import type { Clock } from '../src/ratelimit.ts';
import { invoiceTools } from '../src/tools/invoices.ts';
import { toCallToolResult, type ToolContext } from '../src/tools/shared.ts';

const noWaitClock: Clock = { now: () => Date.now(), sleep: async () => {} };

function harness(response: Response, env: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response.clone();
  }) as unknown as typeof fetch;
  const config = loadConfig({
    SMARTBILL_EMAIL: 'a@b.co',
    SMARTBILL_TOKEN: 'tok',
    SMARTBILL_CIF: 'RO123',
    SMARTBILL_BASE_URL: 'https://api.test/SBORO/api',
    ...env,
  });
  const ctx: ToolContext = {
    client: new SmartBillClient(config, { fetchImpl: impl, clock: noWaitClock }),
    config,
  };
  return { ctx, calls };
}

const tool = (name: string) => {
  const found = invoiceTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('there are exactly seven invoice tools, all smartbill_-prefixed', () => {
  assert.equal(invoiceTools.length, 7);
  for (const t of invoiceTools) assert.match(t.name, /^smartbill_/);
});

test('create_invoice injects companyVatCode from the environment cif', async () => {
  const { ctx, calls } = harness(json({ errorText: '', number: '3593', series: 'fac' }));
  const result = await tool('smartbill_create_invoice').run(ctx, {
    invoice: {
      seriesName: 'fac',
      client: { name: 'X SRL', country: 'Romania' },
      products: [{ name: 'P', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21 }],
    },
  });
  assert.equal(result.ok, true);
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.companyVatCode, 'RO123');
  assert.equal(body.seriesName, 'fac');
});

test('an explicit cif overrides the environment', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_create_invoice').run(ctx, {
    cif: 'RO999',
    invoice: { seriesName: 'fac', client: { name: 'X', country: 'Romania' }, products: [] },
  });
  assert.equal(JSON.parse(String(calls[0]!.init.body)).companyVatCode, 'RO999');
});

test('a create that returns errorText on HTTP 200 is reported as a tool error', async () => {
  const { ctx } = harness(json({ errorText: 'Seria nu a fost gasita!', documentId: -1 }));
  const outcome = await tool('smartbill_create_invoice').run(ctx, {
    invoice: { seriesName: 'nope', client: { name: 'X', country: 'Romania' }, products: [] },
  });
  const result = toCallToolResult(outcome);
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Seria nu a fost gasita/);
});

test('cancel and delete build the right method and query', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_cancel_invoice').run(ctx, { seriesname: 'fac', number: '3593' });
  assert.equal(calls[0]!.init.method, 'PUT');
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/invoice/cancel');
  assert.equal(new URL(calls[0]!.url).searchParams.get('seriesname'), 'fac');

  await tool('smartbill_delete_invoice').run(ctx, { seriesname: 'fac', number: '3593' });
  assert.equal(calls[1]!.init.method, 'DELETE');
  assert.equal(new URL(calls[1]!.url).pathname, '/SBORO/api/invoice');
});

test('only delete_invoice is marked destructive', () => {
  const destructive = invoiceTools.filter((t) => t.annotations?.destructiveHint === true);
  assert.deepEqual(destructive.map((t) => t.name), ['smartbill_delete_invoice']);
});

test('get_invoice_pdf writes a file and returns its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-inv-'));
  const pdf = new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
  const { ctx } = harness(pdf, { SMARTBILL_DOWNLOAD_DIR: dir });
  const outcome = await tool('smartbill_get_invoice_pdf').run(ctx, {
    seriesname: 'fac',
    number: '3593',
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const data = outcome.data as { path: string; bytes: number };
    assert.equal(data.path, join(dir, 'fac-3593.pdf'));
    assert.equal(data.bytes, 4);
  }
});

test('a tool called with no cif anywhere fails without an HTTP call', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }), { SMARTBILL_CIF: '' });
  const outcome = await tool('smartbill_cancel_invoice').run(ctx, { seriesname: 'fac', number: '1' });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 8: Run the tests**

Run: `node --test test/invoices.test.ts test/shared.test.ts`
Expected: PASS, 15 tests total.

- [ ] **Step 9: Verify a real MCP round-trip**

Build and start the server with credentials that will not be used, then send it an
`initialize` and a `tools/list` over stdio:

```bash
npm run build
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SMARTBILL_EMAIL=a@b.co SMARTBILL_TOKEN=t SMARTBILL_CIF=RO1 node dist/index.js
```

Expected: two JSON-RPC responses on stdout; the second lists seven `smartbill_*` tools each with a
populated `inputSchema`. The `7/7 tools registered` line appears on stderr, separate from the wire.
If `tools/list` reports an error about `inputSchema`, the schema is being passed as a raw shape
rather than a `z.object(...)` — fix that before continuing.

- [ ] **Step 10: Commit**

```bash
git add src/tools/ src/index.ts test/shared.test.ts test/invoices.test.ts
git commit -m "feat: tool plumbing, stdio entrypoint and the seven invoice tools"
```

---

## Task 7: Estimate tools

**Files:**
- Create: `src/tools/estimates.ts`
- Modify: `src/tools/index.ts`
- Test: `test/estimates.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `cifArg`, `resolveCif`, `savePdf` (Task 6); `estimateRequestSchema` (Task 5).
- Produces: `export const estimateTools: ToolDef[]` — six entries.

- [ ] **Step 1: Write `src/tools/estimates.ts`**

```ts
import * as z from 'zod';
import { estimateRequestSchema } from '../schemas.ts';
import { cifArg, resolveCif, savePdf, type ToolDef } from './shared.ts';

const docRef = {
  cif: cifArg,
  seriesname: z.string().describe('Proforma series name.'),
  number: z.string().describe('Proforma number.'),
};

/** Every estimate tool but create and pdf is the same shape: cif + series + number on one path. */
const simple = (
  name: string,
  operationId: string,
  title: string,
  description: string,
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  annotations?: ToolDef['annotations'],
): ToolDef => ({
  name,
  operationId,
  api: 'v1',
  title,
  description,
  inputSchema: z.object(docRef),
  ...(annotations ? { annotations } : {}),
  run: async ({ client, config }, args) => {
    const cif = resolveCif(config, args.cif as string | undefined);
    if (typeof cif !== 'string') return { ok: false, error: cif };
    return client.request({
      api: 'v1',
      method,
      path,
      query: { cif, seriesname: args.seriesname as string, number: args.number as string },
    });
  },
});

export const estimateTools: ToolDef[] = [
  {
    name: 'smartbill_create_estimate',
    operationId: 'createEstimateV2',
    api: 'v1',
    title: 'Create proforma (estimate)',
    description:
      'Issue a proforma / estimate. Same product and client rules as an invoice: seriesName, taxName and measuringUnitName must match values configured in the SmartBill account exactly (read them from smartbill_get_series and smartbill_get_tax_and_series), prices EXCLUDE VAT unless isTaxIncluded is true, and taxPercentage is a bare number. ' +
      'A proforma does not generate accounting entries; convert it with smartbill_create_invoice using useEstimateDetails.',
    inputSchema: z.object({ cif: cifArg, estimate: estimateRequestSchema }),
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      const estimate = args.estimate as Record<string, unknown>;
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/estimate/v2',
        body: { companyVatCode: cif, ...estimate },
      });
    },
  },
  {
    name: 'smartbill_get_estimate_pdf',
    operationId: 'getEstimatePdf',
    api: 'v1',
    title: 'Download proforma PDF',
    description:
      'Download a proforma as PDF. The file is written to the server download directory and the tool returns its path and size.',
    inputSchema: z.object(docRef),
    annotations: { readOnlyHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      const res = await client.request({
        api: 'v1',
        method: 'GET',
        path: '/estimate/pdf',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
        binary: true,
      });
      if (!res.ok) return res;
      if (!res.bytes) {
        return { ok: false, error: { message: 'SmartBill returned no PDF content.', httpStatus: res.status } };
      }
      const saved = await savePdf(
        config.downloadDir,
        `${args.seriesname}-${args.number}.pdf`,
        res.bytes,
      );
      return { ok: true, data: saved };
    },
  },
  simple(
    'smartbill_get_estimate_invoices',
    'getEstimateInvoices',
    'List invoices issued from a proforma',
    'List the invoices that were created from a given proforma. Use it to check whether a proforma has already been invoiced before issuing another.',
    'GET',
    '/estimate/invoices',
    { readOnlyHint: true },
  ),
  simple(
    'smartbill_cancel_estimate',
    'cancelEstimate',
    'Cancel proforma',
    'Mark a proforma as cancelled. Reversible with smartbill_restore_estimate.',
    'PUT',
    '/estimate/cancel',
    { destructiveHint: false, idempotentHint: true },
  ),
  simple(
    'smartbill_restore_estimate',
    'restoreEstimate',
    'Restore cancelled proforma',
    'Undo smartbill_cancel_estimate, returning the proforma to its active state.',
    'PUT',
    '/estimate/restore',
    { destructiveHint: false, idempotentHint: true },
  ),
  simple(
    'smartbill_delete_estimate',
    'deleteEstimate',
    'Delete proforma',
    'Permanently delete a proforma. IRREVERSIBLE. Prefer smartbill_cancel_estimate when a record of the document should survive.',
    'DELETE',
    '/estimate',
    { destructiveHint: true },
  ),
];
```

- [ ] **Step 2: Update `src/tools/index.ts`**

```ts
import { estimateTools } from './estimates.ts';
import { invoiceTools } from './invoices.ts';
import type { ToolDef } from './shared.ts';

export const allTools: ToolDef[] = [...invoiceTools, ...estimateTools];
```

- [ ] **Step 3: Write `test/estimates.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import type { Clock } from '../src/ratelimit.ts';
import { estimateTools } from '../src/tools/estimates.ts';
import type { ToolContext } from '../src/tools/shared.ts';

const noWaitClock: Clock = { now: () => Date.now(), sleep: async () => {} };

function harness(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response.clone();
  }) as unknown as typeof fetch;
  const config = loadConfig({
    SMARTBILL_EMAIL: 'a@b.co',
    SMARTBILL_TOKEN: 'tok',
    SMARTBILL_CIF: 'RO123',
    SMARTBILL_BASE_URL: 'https://api.test/SBORO/api',
  });
  const ctx: ToolContext = {
    client: new SmartBillClient(config, { fetchImpl: impl, clock: noWaitClock }),
    config,
  };
  return { ctx, calls };
}

const tool = (name: string) => {
  const found = estimateTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('there are exactly six estimate tools', () => {
  assert.equal(estimateTools.length, 6);
});

test('create_estimate posts to /estimate/v2 with the injected cif', async () => {
  const { ctx, calls } = harness(json({ errorText: '', number: '227' }));
  await tool('smartbill_create_estimate').run(ctx, {
    estimate: {
      seriesName: 'pro',
      client: { name: 'X SRL', country: 'Romania' },
      products: [{ name: 'P', quantity: 1, price: 50, measuringUnitName: 'buc', taxPercentage: 21 }],
    },
  });
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/estimate/v2');
  assert.equal(JSON.parse(String(calls[0]!.init.body)).companyVatCode, 'RO123');
});

test('get_estimate_invoices is a GET on /estimate/invoices', async () => {
  const { ctx, calls } = harness(json({ errorText: '', number: [] }));
  await tool('smartbill_get_estimate_invoices').run(ctx, { seriesname: 'pro', number: '227' });
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/estimate/invoices');
});

test('cancel is PUT and delete is DELETE', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_cancel_estimate').run(ctx, { seriesname: 'pro', number: '227' });
  await tool('smartbill_delete_estimate').run(ctx, { seriesname: 'pro', number: '227' });
  assert.equal(calls[0]!.init.method, 'PUT');
  assert.equal(calls[1]!.init.method, 'DELETE');
});

test('only delete_estimate is marked destructive', () => {
  const destructive = estimateTools.filter((t) => t.annotations?.destructiveHint === true);
  assert.deepEqual(destructive.map((t) => t.name), ['smartbill_delete_estimate']);
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/estimates.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/estimates.ts src/tools/index.ts test/estimates.test.ts
git commit -m "feat: six proforma (estimate) tools"
```

---

## Task 8: Payment tools

**Files:**
- Create: `src/tools/payments.ts`
- Modify: `src/tools/index.ts`
- Test: `test/payments.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `cifArg`, `resolveCif` (Task 6); `paymentRequestSchema`, `deletablePaymentTypeEnum` (Task 5).
- Produces: `export const paymentTools: ToolDef[]` — four entries.

- [ ] **Step 1: Write `src/tools/payments.ts`**

```ts
import * as z from 'zod';
import { deletablePaymentTypeEnum, paymentRequestSchema } from '../schemas.ts';
import { cifArg, resolveCif, type ToolDef } from './shared.ts';

export const paymentTools: ToolDef[] = [
  {
    name: 'smartbill_create_payment',
    operationId: 'createPayment',
    api: 'v1',
    title: 'Record a payment',
    description:
      'Record a payment (incasare) against one or more invoices, or as a standalone receipt. ' +
      'Set useInvoiceDetails with invoicesList to take the client and products from existing invoices instead of restating them. ' +
      'When type is "Chitanta", seriesName must be a receipt series configured in the account (type "c" in smartbill_get_series).',
    inputSchema: z.object({ cif: cifArg, payment: paymentRequestSchema }),
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      const payment = args.payment as Record<string, unknown>;
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/payment',
        body: { companyVatCode: cif, ...payment },
      });
    },
  },
  {
    name: 'smartbill_get_payment_receipt_text',
    operationId: 'getPaymentText',
    api: 'v1',
    title: 'Get fiscal receipt text',
    description:
      'Fetch the fiscal-printer text for a receipt by its document id. The content arrives Base64-encoded in the `message` field of the response.',
    inputSchema: z.object({
      cif: cifArg,
      id: z.number().int().describe('Document id of the receipt, as returned by smartbill_create_payment.'),
    }),
    annotations: { readOnlyHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'GET',
        path: '/payment/text',
        query: { cif, id: args.id as number },
      });
    },
  },
  {
    name: 'smartbill_delete_receipt',
    operationId: 'deleteReceipt',
    api: 'v1',
    title: 'Delete receipt (chitanta)',
    description:
      'Permanently delete a receipt by its series and number. IRREVERSIBLE. This is the only way to remove a Chitanta — smartbill_delete_payment does not accept that type.',
    inputSchema: z.object({
      cif: cifArg,
      seriesname: z.string().describe('Receipt series name.'),
      number: z.string().describe('Receipt number.'),
    }),
    annotations: { destructiveHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'DELETE',
        path: '/payment/chitanta',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    },
  },
  {
    name: 'smartbill_delete_payment',
    operationId: 'deletePaymentV2',
    api: 'v1',
    title: 'Delete a non-receipt payment',
    description:
      'Permanently delete a payment. IRREVERSIBLE. Identify it either by invoice (invoiceSeries + invoiceNumber) or by payment details (paymentDate, paymentValue, clientName, clientCif). ' +
      'paymentType must match the type actually recorded on the payment; a mismatch returns "Nu au fost gasite incasari conform datelor specificate." ' +
      'Chitanta and Bon fiscal cannot be deleted here — use smartbill_delete_receipt for a Chitanta.',
    inputSchema: z.object({
      cif: cifArg,
      paymentType: deletablePaymentTypeEnum.describe('The type recorded on the payment being deleted.'),
      invoiceSeries: z.string().optional(),
      invoiceNumber: z.string().optional(),
      paymentDate: z.string().optional().describe('yyyy-MM-dd.'),
      paymentValue: z.number().optional(),
      clientName: z.string().optional(),
      clientCif: z.string().optional(),
    }),
    annotations: { destructiveHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'DELETE',
        path: '/payment/v2',
        query: {
          cif,
          paymentType: args.paymentType as string,
          invoiceSeries: args.invoiceSeries as string | undefined,
          invoiceNumber: args.invoiceNumber as string | undefined,
          paymentDate: args.paymentDate as string | undefined,
          paymentValue: args.paymentValue as number | undefined,
          clientName: args.clientName as string | undefined,
          clientCif: args.clientCif as string | undefined,
        },
      });
    },
  },
];
```

- [ ] **Step 2: Update `src/tools/index.ts`**

```ts
import { estimateTools } from './estimates.ts';
import { invoiceTools } from './invoices.ts';
import { paymentTools } from './payments.ts';
import type { ToolDef } from './shared.ts';

export const allTools: ToolDef[] = [...invoiceTools, ...estimateTools, ...paymentTools];
```

- [ ] **Step 3: Write `test/payments.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import type { Clock } from '../src/ratelimit.ts';
import { paymentTools } from '../src/tools/payments.ts';
import type { ToolContext } from '../src/tools/shared.ts';

const noWaitClock: Clock = { now: () => Date.now(), sleep: async () => {} };

function harness(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response.clone();
  }) as unknown as typeof fetch;
  const config = loadConfig({
    SMARTBILL_EMAIL: 'a@b.co',
    SMARTBILL_TOKEN: 'tok',
    SMARTBILL_CIF: 'RO123',
    SMARTBILL_BASE_URL: 'https://api.test/SBORO/api',
  });
  const ctx: ToolContext = {
    client: new SmartBillClient(config, { fetchImpl: impl, clock: noWaitClock }),
    config,
  };
  return { ctx, calls };
}

const tool = (name: string) => {
  const found = paymentTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('there are exactly four payment tools', () => {
  assert.equal(paymentTools.length, 4);
});

test('create_payment injects companyVatCode', async () => {
  const { ctx, calls } = harness(json({ errorText: '', number: '7' }));
  await tool('smartbill_create_payment').run(ctx, {
    payment: { type: 'Ordin plata', value: 119, invoicesList: [{ seriesName: 'fac', number: '3593' }] },
  });
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.companyVatCode, 'RO123');
  assert.equal(body.type, 'Ordin plata');
});

test('delete_payment omits the optional identifiers that were not supplied', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_delete_payment').run(ctx, {
    paymentType: 'Ordin plata',
    invoiceSeries: 'fac',
    invoiceNumber: '3593',
  });
  const url = new URL(calls[0]!.url);
  assert.equal(calls[0]!.init.method, 'DELETE');
  assert.equal(url.searchParams.get('paymentType'), 'Ordin plata');
  assert.equal(url.searchParams.has('clientName'), false);
  assert.equal(url.searchParams.has('paymentValue'), false);
});

test('delete_receipt targets /payment/chitanta', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_delete_receipt').run(ctx, { seriesname: 'CH', number: '7' });
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/payment/chitanta');
});

test('both delete tools are marked destructive and the read tool is read-only', () => {
  const destructive = paymentTools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name);
  assert.deepEqual(destructive.sort(), ['smartbill_delete_payment', 'smartbill_delete_receipt']);
  assert.equal(tool('smartbill_get_payment_receipt_text').annotations?.readOnlyHint, true);
});

test('the receipt-text tool sends id as a query parameter', async () => {
  const { ctx, calls } = harness(json({ errorText: '', message: 'Qm9u' }));
  await tool('smartbill_get_payment_receipt_text').run(ctx, { id: 20363 });
  assert.equal(new URL(calls[0]!.url).searchParams.get('id'), '20363');
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/payments.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/payments.ts src/tools/index.ts test/payments.test.ts
git commit -m "feat: four payment tools"
```

---

## Task 9: Company data tools

Tax rates, document series, stock levels, and emailing a document.

**Files:**
- Create: `src/tools/company.ts`
- Modify: `src/tools/index.ts`
- Test: `test/company.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `cifArg`, `resolveCif` (Task 6); `sendEmailRequestSchema` (Task 5).
- Produces: `export const companyTools: ToolDef[]` — four entries.

- [ ] **Step 1: Write `src/tools/company.ts`**

```ts
import * as z from 'zod';
import { sendEmailRequestSchema } from '../schemas.ts';
import { cifArg, resolveCif, type ToolDef } from './shared.ts';

export const companyTools: ToolDef[] = [
  {
    name: 'smartbill_get_tax_and_series',
    operationId: 'getTaxAndSeries',
    api: 'v1',
    title: 'Get VAT rates and company info',
    description:
      'List the VAT rates configured in the SmartBill account, with their names and percentages. ' +
      'Call this before creating a document to get the exact `taxName` and `taxPercentage` values the account accepts — inventing them causes the document to be rejected.',
    inputSchema: z.object({ cif: cifArg }),
    annotations: { readOnlyHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({ api: 'v1', method: 'GET', path: '/tax', query: { cif } });
    },
  },
  {
    name: 'smartbill_get_series',
    operationId: 'getSeries',
    api: 'v1',
    title: 'Get document series',
    description:
      'List the document series configured in the SmartBill account, with the next number for each. ' +
      'Call this before creating a document to get the exact `seriesName` the account accepts. ' +
      'Filter with type: "f" invoices, "p" proformas, "c" receipts. Omit type for all series.',
    inputSchema: z.object({
      cif: cifArg,
      type: z
        .enum(['f', 'p', 'c'])
        .optional()
        .describe('f = invoice, p = proforma, c = receipt. Omit for all series.'),
    }),
    annotations: { readOnlyHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'GET',
        path: '/series',
        query: { cif, type: args.type as string | undefined },
      });
    },
  },
  {
    name: 'smartbill_get_stocks',
    operationId: 'getStocks',
    api: 'v1',
    title: 'Get stock levels',
    description:
      'Query stock levels at a given date. `date` is required and must be yyyy-MM-dd. ' +
      'warehouseName is CASE-SENSITIVE and must match the warehouse name exactly. ' +
      'Omit the optional filters to get everything.',
    inputSchema: z.object({
      cif: cifArg,
      date: z.string().describe('Stock date, yyyy-MM-dd. Required.'),
      warehouseName: z.string().optional().describe('Warehouse name. CASE-SENSITIVE.'),
      productName: z.string().optional(),
      productCode: z.string().optional().describe('Product SKU.'),
    }),
    annotations: { readOnlyHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'GET',
        path: '/stocks',
        query: {
          cif,
          date: args.date as string,
          warehouseName: args.warehouseName as string | undefined,
          productName: args.productName as string | undefined,
          productCode: args.productCode as string | undefined,
        },
      });
    },
  },
  {
    name: 'smartbill_send_document_email',
    operationId: 'sendDocumentEmail',
    api: 'v1',
    title: 'Email a document to a client',
    description:
      'Email an existing invoice or proforma to a client. Omit `to` to use the email address on the client record. ' +
      'type must be "factura" or "proforma".',
    inputSchema: z.object({ cif: cifArg, document: sendEmailRequestSchema }),
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      const document = args.document as Record<string, unknown>;
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/document/send',
        body: { companyVatCode: cif, ...document },
      });
    },
  },
];
```

- [ ] **Step 2: Update `src/tools/index.ts`**

```ts
import { companyTools } from './company.ts';
import { estimateTools } from './estimates.ts';
import { invoiceTools } from './invoices.ts';
import { paymentTools } from './payments.ts';
import type { ToolDef } from './shared.ts';

export const allTools: ToolDef[] = [
  ...invoiceTools,
  ...estimateTools,
  ...paymentTools,
  ...companyTools,
];
```

- [ ] **Step 3: Write `test/company.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import type { Clock } from '../src/ratelimit.ts';
import { companyTools } from '../src/tools/company.ts';
import type { ToolContext } from '../src/tools/shared.ts';

const noWaitClock: Clock = { now: () => Date.now(), sleep: async () => {} };

function harness(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response.clone();
  }) as unknown as typeof fetch;
  const config = loadConfig({
    SMARTBILL_EMAIL: 'a@b.co',
    SMARTBILL_TOKEN: 'tok',
    SMARTBILL_CIF: 'RO123',
    SMARTBILL_BASE_URL: 'https://api.test/SBORO/api',
  });
  const ctx: ToolContext = {
    client: new SmartBillClient(config, { fetchImpl: impl, clock: noWaitClock }),
    config,
  };
  return { ctx, calls };
}

const tool = (name: string) => {
  const found = companyTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('there are exactly four company tools', () => {
  assert.equal(companyTools.length, 4);
});

test('get_series passes the type filter through and omits it when absent', async () => {
  const { ctx, calls } = harness(json({ errorText: '', list: [] }));
  await tool('smartbill_get_series').run(ctx, { type: 'f' });
  assert.equal(new URL(calls[0]!.url).searchParams.get('type'), 'f');

  await tool('smartbill_get_series').run(ctx, {});
  assert.equal(new URL(calls[1]!.url).searchParams.has('type'), false);
});

test('get_series rejects a type outside f/p/c', () => {
  assert.equal(tool('smartbill_get_series').inputSchema.safeParse({ type: 'x' }).success, false);
  assert.equal(tool('smartbill_get_series').inputSchema.safeParse({ type: 'p' }).success, true);
});

test('get_stocks requires a date', () => {
  assert.equal(tool('smartbill_get_stocks').inputSchema.safeParse({}).success, false);
  assert.equal(
    tool('smartbill_get_stocks').inputSchema.safeParse({ date: '2026-07-11' }).success,
    true,
  );
});

test('get_stocks sends the optional filters only when supplied', async () => {
  const { ctx, calls } = harness(json({ errorText: '', list: [] }));
  await tool('smartbill_get_stocks').run(ctx, { date: '2026-07-11', warehouseName: 'Depozit' });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('date'), '2026-07-11');
  assert.equal(url.searchParams.get('warehouseName'), 'Depozit');
  assert.equal(url.searchParams.has('productCode'), false);
});

test('send_document_email posts the document with the injected cif', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_send_document_email').run(ctx, {
    document: { seriesName: 'fac', number: '3593', type: 'factura' },
  });
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/document/send');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.companyVatCode, 'RO123');
  assert.equal(body.type, 'factura');
});

test('the three read tools are marked read-only and email is not', () => {
  const readOnly = companyTools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
  assert.equal(readOnly.length, 3);
  assert.equal(tool('smartbill_send_document_email').annotations?.readOnlyHint, undefined);
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/company.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/company.ts src/tools/index.ts test/company.test.ts
git commit -m "feat: tax, series, stock and document-email tools"
```

---

## Task 10: API V3 tools

Eight read-only tools over four resources, all sharing one shape.

**Files:**
- Create: `src/tools/v3.ts`
- Modify: `src/tools/index.ts`
- Test: `test/v3.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `cifArg`, `resolveCif` (Task 6); `paginationSchema` (Task 5).
- Produces: `export const v3Tools: ToolDef[]` — eight entries.

- [ ] **Step 1: Write `src/tools/v3.ts`**

```ts
import * as z from 'zod';
import { paginationSchema } from '../schemas.ts';
import { cifArg, resolveCif, type ToolDef } from './shared.ts';

const PAGINATION_NOTE =
  'Cursor pagination: limit is 1-100 (default 20); `after` and `before` are ids and are mutually exclusive. ' +
  'pagination.next is a complete URL that already carries the filters — when it is null the listing is finished, even if the last page filled exactly to limit.';

type Resource = {
  /** Path segment and English plural used in names and text. */
  plural: string;
  /** Human-readable singular. */
  singular: string;
  listOperationId: string;
  getOperationId: string;
  /** Stable id prefix, e.g. cus_. */
  idPrefix: string;
  /** Extra query filters this listing accepts, beyond pagination. */
  filters: Record<string, z.ZodType>;
  listDescription: string;
  getDescription: string;
};

const nameFilter = z.string().optional().describe('Filter by name.');
const codeFilter = z.string().optional().describe('Filter by internal code.');
const vatCodeFilter = z.string().optional().describe('Filter by VAT code (CIF).');

const RESOURCES: Resource[] = [
  {
    plural: 'clients',
    singular: 'client',
    listOperationId: 'listClientsV3',
    getOperationId: 'getClientV3',
    idPrefix: 'cus_',
    filters: { name: nameFilter, code: codeFilter, vatCode: vatCodeFilter },
    listDescription: 'List clients from the SmartBill client database.',
    getDescription: 'Fetch one client by id, including its delivery addresses.',
  },
  {
    plural: 'suppliers',
    singular: 'supplier',
    listOperationId: 'listSuppliersV3',
    getOperationId: 'getSupplierV3',
    idPrefix: 'sup_',
    filters: { name: nameFilter, code: codeFilter, vatCode: vatCodeFilter },
    listDescription: 'List suppliers from the SmartBill supplier database.',
    getDescription: 'Fetch one supplier by id.',
  },
  {
    plural: 'products',
    singular: 'product',
    listOperationId: 'listProductsV3',
    getOperationId: 'getProductV3',
    idPrefix: 'prod_',
    filters: { name: nameFilter, code: codeFilter },
    listDescription:
      'List products and services from the SmartBill catalogue, with prices, VAT rates and units of measure.',
    getDescription: 'Fetch one product or service by id.',
  },
  {
    plural: 'warehouses',
    singular: 'warehouse',
    listOperationId: 'listWarehousesV3',
    getOperationId: 'getWarehouseV3',
    idPrefix: 'ware_',
    filters: { name: nameFilter },
    listDescription: 'List warehouses (gestiuni) configured in the account.',
    getDescription: 'Fetch one warehouse by id.',
  },
];

function listTool(resource: Resource): ToolDef {
  return {
    name: `smartbill_v3_list_${resource.plural}`,
    operationId: resource.listOperationId,
    api: 'v3',
    title: `List ${resource.plural} (V3)`,
    description: `${resource.listDescription} Ids are prefixed \`${resource.idPrefix}\` and are stable — save them and reuse them later. ${PAGINATION_NOTE}`,
    inputSchema: z.object({
      cif: cifArg,
      ...resource.filters,
      ...paginationSchema.shape,
    }),
    annotations: { readOnlyHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      if (args.after !== undefined && args.before !== undefined) {
        return {
          ok: false,
          error: {
            message: '`after` and `before` cannot be used together.',
            code: 'invalid_field_value',
            httpStatus: 0,
            hint: 'Pass one cursor direction only.',
          },
        };
      }
      const query: Record<string, string | number | undefined> = {
        limit: args.limit as number | undefined,
        after: args.after as string | undefined,
        before: args.before as string | undefined,
      };
      for (const key of Object.keys(resource.filters)) {
        query[key] = args[key] as string | undefined;
      }
      return client.request({
        api: 'v3',
        method: 'GET',
        path: `/v3/companies/${encodeURIComponent(cif)}/${resource.plural}`,
        query,
      });
    },
  };
}

function getTool(resource: Resource): ToolDef {
  return {
    name: `smartbill_v3_get_${resource.singular}`,
    operationId: resource.getOperationId,
    api: 'v3',
    title: `Get ${resource.singular} (V3)`,
    description: `${resource.getDescription} The id must start with \`${resource.idPrefix}\` — an id from another resource returns 400 malformed_id.`,
    inputSchema: z.object({
      cif: cifArg,
      id: z.string().describe(`Resource id, starting with ${resource.idPrefix}.`),
    }),
    annotations: { readOnlyHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      const id = args.id as string;
      return client.request({
        api: 'v3',
        method: 'GET',
        path: `/v3/companies/${encodeURIComponent(cif)}/${resource.plural}/${encodeURIComponent(id)}`,
      });
    },
  };
}

export const v3Tools: ToolDef[] = RESOURCES.flatMap((r) => [listTool(r), getTool(r)]);
```

- [ ] **Step 2: Update `src/tools/index.ts`**

```ts
import { companyTools } from './company.ts';
import { estimateTools } from './estimates.ts';
import { invoiceTools } from './invoices.ts';
import { paymentTools } from './payments.ts';
import { v3Tools } from './v3.ts';
import type { ToolDef } from './shared.ts';

export const allTools: ToolDef[] = [
  ...invoiceTools,
  ...estimateTools,
  ...paymentTools,
  ...companyTools,
  ...v3Tools,
];
```

- [ ] **Step 3: Write `test/v3.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import type { Clock } from '../src/ratelimit.ts';
import { v3Tools } from '../src/tools/v3.ts';
import { toCallToolResult, type ToolContext } from '../src/tools/shared.ts';

const noWaitClock: Clock = { now: () => Date.now(), sleep: async () => {} };

function harness(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response.clone();
  }) as unknown as typeof fetch;
  const config = loadConfig({
    SMARTBILL_V3_TOKEN: 'sb_live_x',
    SMARTBILL_CIF: 'RO123',
    SMARTBILL_BASE_URL: 'https://api.test/SBORO/api',
  });
  const ctx: ToolContext = {
    client: new SmartBillClient(config, { fetchImpl: impl, clock: noWaitClock }),
    config,
  };
  return { ctx, calls };
}

const tool = (name: string) => {
  const found = v3Tools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('there are eight V3 tools and all are read-only', () => {
  assert.equal(v3Tools.length, 8);
  for (const t of v3Tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} should be read-only`);
    assert.equal(t.api, 'v3');
  }
});

test('list tools build the /v3/companies/{cif}/{resource} path', async () => {
  const { ctx, calls } = harness(json({ items: [], pagination: { next: null, previous: null } }));
  await tool('smartbill_v3_list_clients').run(ctx, {});
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/v3/companies/RO123/clients');
});

test('get tools append the id to the path', async () => {
  const { ctx, calls } = harness(json({ id: 'ware_abc', name: 'Depozit' }));
  await tool('smartbill_v3_get_warehouse').run(ctx, { id: 'ware_abc' });
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/v3/companies/RO123/warehouses/ware_abc');
});

test('V3 uses Bearer auth', async () => {
  const { ctx, calls } = harness(json({ items: [], pagination: {} }));
  await tool('smartbill_v3_list_products').run(ctx, {});
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer sb_live_x');
});

test('pagination and filter parameters are forwarded, absent ones omitted', async () => {
  const { ctx, calls } = harness(json({ items: [], pagination: {} }));
  await tool('smartbill_v3_list_clients').run(ctx, { limit: 5, after: 'cus_abc', name: 'Acme' });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('after'), 'cus_abc');
  assert.equal(url.searchParams.get('name'), 'Acme');
  assert.equal(url.searchParams.has('before'), false);
  assert.equal(url.searchParams.has('vatCode'), false);
});

test('after and before together are rejected without an HTTP call', async () => {
  const { ctx, calls } = harness(json({ items: [] }));
  const outcome = await tool('smartbill_v3_list_clients').run(ctx, { after: 'cus_a', before: 'cus_b' });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});

test('warehouses accept only the name filter', () => {
  const schema = tool('smartbill_v3_list_warehouses').inputSchema;
  assert.equal(schema.safeParse({ name: 'Depozit' }).success, true);
  assert.equal('vatCode' in schema.shape, false);
});

test('limit outside 1-100 is rejected by the schema', () => {
  const schema = tool('smartbill_v3_list_products').inputSchema;
  assert.equal(schema.safeParse({ limit: 101 }).success, false);
  assert.equal(schema.safeParse({ limit: 100 }).success, true);
});

test('a V3 validation error surfaces every error element', async () => {
  const { ctx } = harness(
    json(
      {
        status: 400,
        type: 'validation_error',
        instance: '/api/v3/clients',
        errors: [
          { code: 'invalid_field_value', message: 'limit out of range', param: 'limit' },
          { code: 'malformed_id', message: 'bad cursor', param: 'after' },
        ],
      },
      400,
    ),
  );
  const result = toCallToolResult(await tool('smartbill_v3_list_clients').run(ctx, {}));
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /invalid_field_value/);
  assert.match(result.content[0]!.text, /malformed_id/);
});

test('missing the V3 token fails without an HTTP call', async () => {
  const calls: unknown[] = [];
  const impl = (async () => {
    calls.push(1);
    return json({});
  }) as unknown as typeof fetch;
  const config = loadConfig({ SMARTBILL_CIF: 'RO1' });
  const ctx: ToolContext = {
    client: new SmartBillClient(config, { fetchImpl: impl, clock: noWaitClock }),
    config,
  };
  const outcome = await tool('smartbill_v3_list_clients').run(ctx, {});
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/v3.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/v3.ts src/tools/index.ts test/v3.test.ts
git commit -m "feat: eight read-only API V3 tools with cursor pagination"
```

---

## Task 11: Spec coverage test and documentation

The coverage test is the guard that makes hand-written tools safe: it fails the moment the spec
gains an operation that has no tool.

**Files:**
- Create: `test/coverage.test.ts`, `README.md`
- Test: `test/coverage.test.ts`

**Interfaces:**
- Consumes: `allTools` (Tasks 6-10).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write `test/coverage.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allTools } from '../src/tools/index.ts';

type SpecOperation = { operationId?: string; security?: Array<Record<string, unknown>> };
type Spec = { paths: Record<string, Record<string, SpecOperation>> };

const METHODS = ['get', 'post', 'put', 'delete', 'patch'];

async function loadSpec(): Promise<Spec> {
  const raw = await readFile(new URL('../docs/smartbill-openapi-spec.json', import.meta.url), 'utf8');
  return JSON.parse(raw) as Spec;
}

/** Every operationId in the spec, with the auth scheme its security block names. */
async function specOperations(): Promise<Map<string, 'v1' | 'v3'>> {
  const spec = await loadSpec();
  const ops = new Map<string, 'v1' | 'v3'>();
  for (const methods of Object.values(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!METHODS.includes(method) || !op.operationId) continue;
      const usesBearer = (op.security ?? []).some((s) => 'bearerAuth' in s);
      ops.set(op.operationId, usesBearer ? 'v3' : 'v1');
    }
  }
  return ops;
}

test('the spec still has 29 operations', async () => {
  assert.equal((await specOperations()).size, 29);
});

test('every spec operation has exactly one tool', async () => {
  const ops = await specOperations();
  const covered = new Set(allTools.map((t) => t.operationId));
  const missing = [...ops.keys()].filter((id) => !covered.has(id));
  assert.deepEqual(missing, [], `operations with no tool: ${missing.join(', ')}`);
});

test('every tool maps to a real spec operation', async () => {
  const ops = await specOperations();
  const unknown = allTools.filter((t) => !ops.has(t.operationId)).map((t) => t.operationId);
  assert.deepEqual(unknown, [], `tools referencing no spec operation: ${unknown.join(', ')}`);
});

test('no operationId is claimed by two tools', () => {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const t of allTools) {
    if (seen.has(t.operationId)) duplicates.push(t.operationId);
    seen.add(t.operationId);
  }
  assert.deepEqual(duplicates, []);
});

test('each tool declares the api version its spec security block requires', async () => {
  const ops = await specOperations();
  for (const t of allTools) {
    assert.equal(t.api, ops.get(t.operationId), `${t.name} declares api ${t.api}`);
  }
});

test('tool names are unique and smartbill_-prefixed', () => {
  const names = allTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^smartbill_[a-z0-9_]+$/);
});

test('every tool has a title and a description of real substance', () => {
  for (const t of allTools) {
    assert.ok(t.title.length > 0, `${t.name} has no title`);
    assert.ok(t.description.length > 40, `${t.name} has a thin description`);
  }
});

test('exactly four tools are marked destructive, and they are the deletes', () => {
  const destructive = allTools
    .filter((t) => t.annotations?.destructiveHint === true)
    .map((t) => t.name)
    .sort();
  assert.deepEqual(destructive, [
    'smartbill_delete_estimate',
    'smartbill_delete_invoice',
    'smartbill_delete_payment',
    'smartbill_delete_receipt',
  ]);
});

test('sixteen tools are read-only', () => {
  // 2 invoice + 2 estimate + 1 payment + 3 company + 8 V3.
  const readOnly = allTools.filter((t) => t.annotations?.readOnlyHint === true);
  assert.equal(readOnly.length, 16);
});

test('there are 29 tools in total', () => {
  assert.equal(allTools.length, 29);
});
```

- [ ] **Step 2: Run the coverage test**

Run: `node --test test/coverage.test.ts`
Expected: PASS, 10 tests. A failure here names exactly which operation is unwired — fix the tool
module rather than the test.

- [ ] **Step 3: Write `README.md`**

````markdown
# SmartBill MCP Server

An MCP server exposing the [SmartBill Cloud API](https://api.smartbill.ro/) — all 29 operations
across API V1 (invoicing, payments, stock, configuration) and API V3 (clients, suppliers,
products, warehouses).

## Install

```bash
npm install
npm run build
```

Requires Node 20 or newer.

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
| `smartbill_cancel_invoice` | Cancel (reversible) |
| `smartbill_restore_invoice` | Undo a cancel |
| `smartbill_delete_invoice` | Delete permanently |

### Proformas

`smartbill_create_estimate`, `smartbill_get_estimate_pdf`, `smartbill_get_estimate_invoices`,
`smartbill_cancel_estimate`, `smartbill_restore_estimate`, `smartbill_delete_estimate`

### Payments

`smartbill_create_payment`, `smartbill_get_payment_receipt_text`, `smartbill_delete_receipt`,
`smartbill_delete_payment`

### Company data

`smartbill_get_tax_and_series`, `smartbill_get_series`, `smartbill_get_stocks`,
`smartbill_send_document_email`

### API V3 (read-only)

`smartbill_v3_list_clients` / `smartbill_v3_get_client`, and the same pair for `suppliers`,
`products` and `warehouses`.

## Things worth knowing

- **`seriesName`, `taxName` and `measuringUnitName` are account-specific.** They must match what is
  configured in SmartBill Cloud exactly. Read them with `smartbill_get_series` and
  `smartbill_get_tax_and_series` rather than guessing.
- **Product prices exclude VAT by default.** Set `isTaxIncluded: true` only when the price already
  includes it.
- **An HTTP 200 from API V1 is not proof of success.** The server checks `errorText` on every
  response and reports a non-empty one as a tool error, so this is handled — but it is why a raw
  `curl` against the API can look like it worked when it did not.
- **PDFs go to disk**, not into the conversation. The tools return a path and a byte count.
- **Rate limits are enforced client-side.** V1 allows 30 requests per 10 seconds and blocks the
  token for 10 minutes on a breach, so the server delays requests that would cross the line.
- **Deletes are irreversible.** For an invoice already sent to a client, issue a storno instead.

## Development

```bash
npm test          # node:test, no network
npm run typecheck
npm run build
```

`test/coverage.test.ts` asserts that every operation in `docs/smartbill-openapi-spec.json` has
exactly one tool. Update the spec file and it will tell you what is missing.
````

- [ ] **Step 4: Run the whole suite, typecheck and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass across every file; typecheck silent; `dist/` populated.

- [ ] **Step 5: Verify all 29 tools register over a real stdio session**

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SMARTBILL_EMAIL=a@b.co SMARTBILL_TOKEN=t SMARTBILL_V3_TOKEN=sb_x SMARTBILL_CIF=RO1 node dist/index.js \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.trim().split("\n")){const m=JSON.parse(l);if(m.id===2)console.log(m.result.tools.length,"tools:",m.result.tools.map(t=>t.name).join(" "))}})'
```

Expected: `29 tools: smartbill_create_invoice ...`.

Then confirm the credential gating works:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SMARTBILL_V3_TOKEN=sb_x SMARTBILL_CIF=RO1 node dist/index.js 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.trim().split("\n")){const m=JSON.parse(l);if(m.id===2)console.log(m.result.tools.length,"tools")}})'
```

Expected: `8 tools` — V1 is absent, so only the V3 tools register.

- [ ] **Step 6: Commit**

```bash
git add test/coverage.test.ts README.md
git commit -m "test: assert full spec coverage; docs: README"
```

---

## Self-Review

**Spec coverage.** Every section of the design document maps to a task:

| Spec section | Task |
|---|---|
| §2.1(1) 200-with-errorText | 2 (`errors.ts`), 4 (client), 6 (invoice test) |
| §2.1(2) invalid_request_error | 2 |
| §2.1(3) HTML in errorText | 2 (`stripHtml`) |
| §2.1(4) HTML 500 | 2, 4 |
| §2.1(5) multiple V3 errors | 2, 6 (`renderError`), 10 |
| §2.1(6) account-dependent strings | 5 (schema descriptions), 6-9 (tool descriptions) |
| §2.1(7) isTaxIncluded | 5, 6 |
| §2.1(8) bare-number percentages | 5 |
| §2.1(9) V3 id prefixes | 10 |
| §2.1(10) pagination.next | 10 |
| §2.1(11) rate limits | 3, 4 |
| §3 architecture, SDK v2 API | 1, 4, 6 |
| §4 configuration, stderr, gating | 1, 6 |
| §5 HTTP client | 4 |
| §6 error normalisation | 2 |
| §7 29 tools and annotations | 6, 7, 8, 9, 10 |
| §7.2 PDFs to disk | 6 (`savePdf`), 7 |
| §8 testing | every task; coverage in 11 |
| §9 deliverables | 1, 11 |

Nothing in the spec is unimplemented.

**Placeholder scan.** No `TBD`, no "similar to Task N", no "add error handling" — every code step
carries the code. Task 7's `simple` helper is written out in full rather than referenced.

**Type consistency.** `ToolDef.run` returns `ClientResult | ToolOutcome` in Task 6 and every tool
module honours that union. `resolveCif` returns `string | SmartBillError` and every caller narrows
with `typeof cif !== 'string'`. `Clock` is defined in Task 3 and imported by Tasks 4 and 6-10.
`loadConfig` takes `Record<string, string | undefined>` so tests pass literals. `SlidingWindow` is
constructed with `(max, windowMs, clock)` in both Task 3 and Task 4. `savePdf(dir, filename, bytes)`
matches its two call sites.

**Test counts.** 5 + 11 + 6 + 14 + 5 + 15 + 5 + 6 + 7 + 10 + 10 = 94 assertions-bearing tests.
