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
