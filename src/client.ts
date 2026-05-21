import { google } from 'googleapis';
import { ACCOUNT_CONFIG } from './accounts.js';
import type { Account } from './accounts.js';
import { readToken, writeToken } from './token-store.js';

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

  const tokenData = readToken(account);
  if (!tokenData) {
    throw new Error(
      `No token found for account "${account}" (${config.email}). ` +
        `Run: npx mcp-google-multi auth --account ${account}`,
    );
  }

  oauth2Client.setCredentials(tokenData);

  oauth2Client.on('tokens', (tokens) => {
    const existing = readToken(account) ?? {};
    writeToken(account, { ...existing, ...tokens });
  });

  return oauth2Client;
}
