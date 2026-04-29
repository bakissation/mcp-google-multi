import { google } from 'googleapis';
import fs from 'node:fs/promises';
import { ACCOUNT_CONFIG } from './accounts.js';
import type { Account } from './accounts.js';
import type { TokenData } from './types.js';

export async function getClient(account: Account) {
  const config = ACCOUNT_CONFIG[account];

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set. ' +
        'Check that .env exists in the project root or pass them as env vars.',
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:4242/oauth2callback',
  );

  let tokenData: TokenData;
  try {
    const raw = await fs.readFile(config.tokenPath, 'utf-8');
    tokenData = JSON.parse(raw);
  } catch {
    throw new Error(
      `No token file found for account "${account}" at ${config.tokenPath}. ` +
        `Run: node dist/index.js auth --account ${account}`,
    );
  }

  oauth2Client.setCredentials(tokenData);

  // 0o600: tokens grant full account access; keep them user-only.
  oauth2Client.on('tokens', async (tokens) => {
    try {
      const existing = JSON.parse(
        await fs.readFile(config.tokenPath, 'utf-8'),
      );
      const merged = { ...existing, ...tokens };
      await fs.writeFile(config.tokenPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    } catch {
      // If we can't read the existing file, just write the new tokens
      await fs.writeFile(config.tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    }
  });

  return oauth2Client;
}
