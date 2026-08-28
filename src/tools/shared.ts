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
