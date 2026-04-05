import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolve paths relative to the project root (parent of src/ or dist/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the project root (not CWD) so it works when spawned by Claude Code
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const tokenDir = path.resolve(__dirname, '..', 'tokens');

export interface AccountConfig {
  email: string;
  tokenPath: string;
}

/**
 * Parse accounts from the GOOGLE_ACCOUNTS env var.
 * Format: "alias1:email1,alias2:email2,..."
 * Example: "work:me@company.com,personal:me@gmail.com"
 */
function parseAccounts(): { aliases: [string, ...string[]]; configs: Record<string, AccountConfig> } {
  const raw = process.env.GOOGLE_ACCOUNTS;
  if (!raw || raw.trim() === '') {
    throw new Error(
      'GOOGLE_ACCOUNTS is not set. Define it in .env like:\n' +
        'GOOGLE_ACCOUNTS=work:user@company.com,personal:user@gmail.com',
    );
  }

  const configs: Record<string, AccountConfig> = {};
  const aliases: string[] = [];

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(
        `Invalid account entry "${trimmed}". Expected format: alias:email`,
      );
    }

    const alias = trimmed.slice(0, colonIdx).trim();
    const email = trimmed.slice(colonIdx + 1).trim();

    if (!alias || !email) {
      throw new Error(
        `Invalid account entry "${trimmed}". Both alias and email are required.`,
      );
    }

    aliases.push(alias);
    configs[alias] = {
      email,
      tokenPath: path.join(tokenDir, alias, 'token.json'),
    };
  }

  if (aliases.length === 0) {
    throw new Error('GOOGLE_ACCOUNTS must define at least one account.');
  }

  return { aliases: aliases as [string, ...string[]], configs };
}

const parsed = parseAccounts();

/** Tuple of account aliases (at least one) — usable with z.enum() */
export const ACCOUNTS = parsed.aliases;

/** Map of alias → { email, tokenPath } */
export const ACCOUNT_CONFIG = parsed.configs;

/** Valid account alias (string union isn't static, so tools use z.enum(ACCOUNTS)) */
export type Account = string;
