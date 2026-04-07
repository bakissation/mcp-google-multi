import { google } from 'googleapis';
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import open from 'open';
import destroyer from 'server-destroy';
import { ACCOUNTS, ACCOUNT_CONFIG } from './accounts.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/contacts',
];

export async function runAuthFlow(args: string[]): Promise<void> {
  const accountIdx = args.indexOf('--account');
  if (accountIdx === -1 || !args[accountIdx + 1]) {
    console.error('Usage: node dist/index.js auth --account <alias>');
    console.error(`Valid aliases: ${ACCOUNTS.join(', ')}`);
    process.exit(1);
  }

  const alias = args[accountIdx + 1];
  if (!ACCOUNTS.includes(alias)) {
    console.error(`Unknown account "${alias}". Valid aliases: ${ACCOUNTS.join(', ')}`);
    process.exit(1);
  }

  const config = ACCOUNT_CONFIG[alias];

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:4242/oauth2callback',
  );

  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    login_hint: config.email,
  });

  console.log(`Authenticating account "${alias}" (${config.email})...`);
  console.log(`Opening browser for authorization...`);

  return new Promise((resolve, reject) => {
    const server = http
      .createServer(async (req, res) => {
        try {
          if (req.url && req.url.startsWith('/oauth2callback')) {
            const qs = new URL(req.url, 'http://localhost:4242').searchParams;

            const error = qs.get('error');
            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end(`Authorization denied: ${error}`);
              (server as any).destroy();
              reject(new Error(`Authorization denied: ${error}`));
              return;
            }

            const code = qs.get('code');
            if (!code) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('No authorization code received.');
              (server as any).destroy();
              reject(new Error('No authorization code received'));
              return;
            }

            const { tokens } = await oauth2Client.getToken(code);

            // Ensure directory exists
            await fs.mkdir(path.dirname(config.tokenPath), { recursive: true });
            await fs.writeFile(
              config.tokenPath,
              JSON.stringify(tokens, null, 2),
            );

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
              '<h2>Authentication successful!</h2><p>You can close this tab.</p>',
            );
            (server as any).destroy();

            console.log(`Token saved to ${config.tokenPath}`);
            resolve();
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal error during authentication.');
          (server as any).destroy();
          reject(e);
        }
      })
      .listen(4242, () => {
        open(authorizeUrl, { wait: false }).then((cp) => cp.unref());
      });

    destroyer(server);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error('Port 4242 is already in use. Close the process using it and retry.');
        process.exit(1);
      }
      reject(err);
    });
  });
}
