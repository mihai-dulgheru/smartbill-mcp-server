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
  /**
   * True when SmartBill's own spec documents this operation returning HTTP 200 with a
   * non-empty `errorText` as a success (an idempotent no-op, or a purely informational note).
   * Only ever relaxes the 200 case — a non-200 response still fails on a non-empty `errorText`
   * exactly as it does everywhere else. Default false: a 200 with `errorText` is a failure.
   */
  errorTextIsInformational?: boolean;
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
  // Number('') is 0, not NaN — without this check a blank header (e.g. an empty Retry-After)
  // would be read as "wait zero seconds" and retried immediately, the one thing the docs warn
  // against, instead of being treated as absent like a missing header.
  if (raw === null || raw === '') return undefined;
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

/**
 * Builds the error for a response that genuinely arrived but whose body then failed to read or
 * parse. Distinct from `networkError`, which is only for `fetch` itself rejecting: here the
 * server answered, so the real HTTP status is known and connectivity was never the problem.
 */
function bodyReadError(status: number, what: string, cause: unknown): SmartBillError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    message: `SmartBill returned a response whose ${what}: ${detail}`,
    httpStatus: status,
    hint: 'The response body was malformed or truncated.',
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
      // The PDF endpoints echo whatever Accept they were sent back as the response Content-Type,
      // even though the body is always the same PDF bytes — so Content-Type can't be trusted to
      // pick a decoder, and a two-value list is untested against a server documented to mirror a
      // single value. `*/*` is one of the few values the spec explicitly blesses (alongside
      // `application/octet-stream`, `application/json`, and no header at all) and, being a
      // wildcard, can't itself be echoed back as a concrete `Content-Type` that would fool the
      // JSON decoder in #send.
      accept: spec.binary ? '*/*' : 'application/json',
    };
    const init: RequestInit = { method: spec.method, headers };
    if (spec.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(spec.body);
    }

    const errorTextIsInformational = spec.errorTextIsInformational ?? false;
    const first = await this.#send(spec.api, url, init, errorTextIsInformational);

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
    return this.#send(spec.api, url, init, errorTextIsInformational);
  }

  async #send(
    api: ApiVersion,
    url: string,
    init: RequestInit,
    errorTextIsInformational: boolean,
  ): Promise<ClientResult> {
    await this.#windows[api].acquire();

    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (cause) {
      return { ok: false, error: networkError(cause), status: 0, rateLimit: {} };
    }

    const rateLimit = readRateLimit(response.headers);
    // The server's own count is the only signal that sees every process sharing this token — our
    // local sliding window only sees this process. When it says the window is exhausted, hold
    // further requests until its reset time rather than trusting our own count alone.
    if (rateLimit.remaining !== undefined && rateLimit.remaining <= 0 && rateLimit.reset !== undefined) {
      this.#windows[api].holdUntil(rateLimit.reset * 1000);
    }
    // Lowercased once so every check below is case-insensitive, matching a server that sends
    // e.g. `Application/JSON` or `Text/HTML`.
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const status = response.status;

    // Decode by what actually came back, not by what was expected: the PDF endpoints return
    // JSON when they fail.
    if (contentType.includes('application/json')) {
      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        return { ok: false, error: bodyReadError(status, 'JSON body could not be parsed', cause), status, rateLimit };
      }
      const error = normalizeError(status, contentType, body, errorTextIsInformational);
      return error
        ? { ok: false, error, status, rateLimit }
        : { ok: true, data: body, status, rateLimit };
    }

    if (contentType.includes('text/html')) {
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        return { ok: false, error: bodyReadError(status, 'HTML body could not be read', cause), status, rateLimit };
      }
      const error = normalizeError(status, contentType, text);
      return { ok: false, error: error ?? { message: text.slice(0, 200), httpStatus: status }, status, rateLimit };
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      return { ok: false, error: bodyReadError(status, 'binary body could not be read', cause), status, rateLimit };
    }
    // No recognisable JSON/HTML envelope here (body is undefined): normalizeError falls back to
    // trusting the status code, which is the same shape the binary branch used to hand-build.
    const error = normalizeError(status, contentType, undefined);
    return error
      ? { ok: false, error, status, rateLimit }
      : { ok: true, data: undefined, bytes, status, rateLimit };
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
