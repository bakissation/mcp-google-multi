import { OAuth2Client } from 'googleapis-common';
import { getAccountSet, refreshAccountSetIfStale } from './accounts.js';
import type { Account } from './accounts.js';
import { readToken, updateToken } from './token-store.js';
import { reauthHint } from './reauth-hint.js';

export async function getClient(account: Account) {
  // BR-7: lazy cross-process reload — one stat per dispatch, no watcher;
  // reload failures keep the last-good registry, never kill the server.
  refreshAccountSetIfStale();
  const config = getAccountSet().configs[account];
  if (!config) {
    throw new Error(
      `Unknown account "${account}". Valid aliases: ${getAccountSet().aliases.join(', ')}`,
    );
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set. ' +
        'Check that .env exists in the project root or pass them as env vars.',
    );
  }

  const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:4242/oauth2callback',
  );

  const tokenData = readToken(account);
  if (!tokenData) {
    throw new Error(`No token found for account "${account}" (${config.email}). ${reauthHint(account)}`);
  }

  oauth2Client.setCredentials(tokenData);

  oauth2Client.on('tokens', (tokens) => {
    updateToken(account, tokens);
  });

  return oauth2Client;
}
