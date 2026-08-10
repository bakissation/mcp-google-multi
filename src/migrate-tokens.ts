import fs from 'node:fs';
import { getAccountSet } from './accounts.js';
import { writeToken, hasToken } from './token-store.js';

export function runMigrateTokens(): void {
  let migrated = 0;
  let skipped = 0;
  const { aliases, configs } = getAccountSet();
  for (const alias of aliases) {
    const plain = configs[alias].tokenPath;
    if (!fs.existsSync(plain)) continue;
    if (hasToken(alias)) {
      console.log(`• ${alias}: encrypted token already exists, skipping`);
      skipped++;
      continue;
    }
    writeToken(alias, JSON.parse(fs.readFileSync(plain, 'utf8')));
    console.log(`✓ ${alias}: migrated ${plain} → encrypted store`);
    migrated++;
  }
  console.log(
    `Done. ${migrated} migrated, ${skipped} skipped. ` +
      'Delete the plaintext tokens/<alias>/token.json once verified.',
  );
}
