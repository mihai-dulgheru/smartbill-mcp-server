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
