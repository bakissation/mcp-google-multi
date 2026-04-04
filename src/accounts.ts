import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ACCOUNTS = ['ic', 'personal', 'fatoura'] as const;
export type Account = (typeof ACCOUNTS)[number];

// Resolve token dir relative to the project root (parent of src/ or dist/)
// This avoids issues with sandboxed $HOME environments
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokenDir = path.resolve(__dirname, '..', 'tokens');

export const ACCOUNT_CONFIG: Record<
  Account,
  { email: string; tokenPath: string }
> = {
  ic: {
    email: 'baki@ideacrafters.com',
    tokenPath: path.join(tokenDir, 'ic', 'token.json'),
  },
  personal: {
    email: 'abdelbaki.berkati@gmail.com',
    tokenPath: path.join(tokenDir, 'personal', 'token.json'),
  },
  fatoura: {
    email: 'baki@fatoura.app',
    tokenPath: path.join(tokenDir, 'fatoura', 'token.json'),
  },
};
