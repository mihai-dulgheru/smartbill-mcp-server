import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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

/**
 * Wraps a tool `run` so the cif guard lives in one place instead of being copy-pasted into every
 * tool. "Never make an HTTP call without a resolved cif" is a correctness invariant, not a style
 * preference — a copy-pasted guard is one a future tool author can silently omit. This produces a
 * `ToolDef['run']`; it does not change that type.
 */
export function withCif(
  run: (ctx: ToolContext, args: Record<string, unknown>, cif: string) => Promise<ClientResult | ToolOutcome>,
): ToolDef['run'] {
  return async (ctx, args) => {
    const cif = resolveCif(ctx.config, args.cif as string | undefined);
    if (typeof cif !== 'string') return { ok: false, error: cif };
    return run(ctx, args, cif);
  };
}

/**
 * Overrides the error hint on a response carrying a specific HTTP status, leaving every other
 * field untouched. Some SmartBill endpoints document a status/body combination that means the
 * OPPOSITE of the generic hint errors.ts attaches for that shape — e.g. a 502 HTML page that is
 * this endpoint's documented normal failure mode, not a gateway fluke worth retrying. errors.ts
 * cannot know which operation is calling it, so the correction lives in the tool instead.
 */
export function withStatusHint(result: ClientResult, status: number, hint: string): ClientResult {
  if (result.ok || result.status !== status) return result;
  return { ...result, error: { ...result.error, hint } };
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

/**
 * Writes a document to disk and returns its path — PDFs are never inlined into model context.
 *
 * Defends its own contract rather than relying on callers to pass safe names. The whitelist below
 * strips path separators, but a sanitised name of exactly "." or ".." would still resolve to the
 * download directory itself or its parent — both are rejected explicitly. The containment check
 * afterwards is a second, independent layer: it still holds even if the whitelist regex is ever
 * loosened by a future edit.
 */
export async function savePdf(
  dir: string,
  filename: string,
  bytes: Uint8Array,
): Promise<{ path: string; bytes: number }> {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe === '.' || safe === '..') {
    throw new Error(`savePdf: refusing to write unsafe filename "${filename}" (sanitises to "${safe}")`);
  }

  const resolvedDir = resolve(dir);
  const path = resolve(resolvedDir, safe);
  const rel = relative(resolvedDir, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`savePdf: "${filename}" would write outside the download directory`);
  }

  await mkdir(resolvedDir, { recursive: true });
  await writeFile(path, bytes);
  return { path, bytes: bytes.length };
}
