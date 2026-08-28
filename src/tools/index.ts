import { estimateTools } from './estimates.ts';
import { invoiceTools } from './invoices.ts';
import type { ToolDef } from './shared.ts';

export const allTools: ToolDef[] = [...invoiceTools, ...estimateTools];
