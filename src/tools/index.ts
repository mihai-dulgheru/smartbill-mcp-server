import { estimateTools } from './estimates.ts';
import { invoiceTools } from './invoices.ts';
import { paymentTools } from './payments.ts';
import type { ToolDef } from './shared.ts';

export const allTools: ToolDef[] = [...invoiceTools, ...estimateTools, ...paymentTools];
