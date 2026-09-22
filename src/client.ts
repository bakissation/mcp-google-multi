import { OAuth2Client } from 'googleapis-common';
import { getAccountSet, refreshAccountSetIfStale } from './accounts.js';
import type { Account } from './accounts.js';
import { readToken, updateToken } from './token-store.js';
import { reauthHint } from './reauth-hint.js';

/** A local precondition failure, carrying a code the error mapper classifies
 * on. Without it these land on the generic floor and read as Google errors. */
function tagged(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export async function getClient(account: Account) {
  // BR-7: lazy cross-process reload — one stat per dispatch, no watcher;
  // reload failures keep the last-good registry, never kill the server.
  refreshAccountSetIfStale();
  const config = getAccountSet().configs[account];
  if (!config) {
    // Tagged so mapGoogleError can classify it. Untagged, a caller's typo in
    // an alias came back as `upstream_error` with "Unclassified error", i.e.
    // the server blaming Google for a local argument mistake.
    throw tagged(
      `Unknown account "${account}". Valid aliases: ${getAccountSet().aliases.join(', ')}`,
      'E_UNKNOWN_ACCOUNT',
    );
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw tagged(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set. ' +
        'Check that .env exists in the project root or pass them as env vars.',
      'E_NO_OAUTH_CLIENT',
    );
  }

  // Redirect URI is unused on the refresh-token grant; consent flows bind an
  // ephemeral loopback port at auth time (oauth-consent.ts).
  const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost/oauth2callback',
  );

  const tokenData = readToken(account);
  if (!tokenData) {
    throw tagged(`No token found for account "${account}" (${config.email}). ${reauthHint(account)}`, 'E_NO_TOKEN');
  }

  oauth2Client.setCredentials(tokenData);

  oauth2Client.on('tokens', (tokens) => {
    updateToken(account, tokens);
  });

  return oauth2Client;
}
