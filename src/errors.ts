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
