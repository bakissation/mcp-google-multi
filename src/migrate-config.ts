import { CONFIG_VERSION, configFilePath, loadConfigFile, mutateConfigFile } from './config-file.js';
import type { ConfigFile } from './config-file.js';
import { BUNDLE_CATALOG, closestBundle, resolveBundleAliases } from './scope-catalog.js';

function parseCsv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Synthesize config.json accounts{} from the v5 env (GOOGLE_ACCOUNTS +
 * GOOGLE_ADMIN_ACCOUNTS). Never deletes or edits env; idempotent (a re-run
 * that changes nothing says so). Scope-profile and preference fields are
 * migrated by their own slices' commands.
 */
export function runMigrateConfig(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.GOOGLE_ACCOUNTS;
  if (!raw || raw.trim() === '') {
    console.log('GOOGLE_ACCOUNTS is not set — nothing to migrate.');
    return;
  }
  const adminAliases = parseCsv(env.GOOGLE_ADMIN_ACCOUNTS);
  const desired: NonNullable<ConfigFile['accounts']> = {};
  const entries = raw.split(',');
  for (let i = 0; i < entries.length; i++) {
    const trimmed = entries[i].trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      console.error(`Skipping GOOGLE_ACCOUNTS entry ${i + 1}: expected alias:email.`);
      continue;
    }
    const alias = trimmed.slice(0, colonIdx).trim();
    const email = trimmed.slice(colonIdx + 1).trim();
    if (!alias || !email || !/^[a-zA-Z0-9_-]+$/.test(alias)) {
      console.error(`Skipping GOOGLE_ACCOUNTS entry ${i + 1}: empty or invalid alias/email.`);
      continue;
    }
    desired[alias] = { email };
  }

  // Legacy global scopes (BC7) become an explicit named profile every account
  // points at, so removing the env var later changes nothing.
  const legacyNames = parseCsv(env.GOOGLE_OPTIONAL_SCOPES);
  let legacyProfile: { bundles: string[] } | undefined;
  if (legacyNames.length > 0) {
    const bundles = resolveBundleAliases(legacyNames);
    for (const bundle of bundles) {
      if (bundle === 'admin') {
        console.error(
          'E_UNKNOWN_BUNDLE: "admin" is not a global bundle: use GOOGLE_ADMIN_ACCOUNTS or an "admin: true" scope profile. Nothing written.',
        );
        process.exitCode = 1;
        return;
      }
      if (!(bundle in BUNDLE_CATALOG)) {
        const hint = closestBundle(bundle);
        console.error(
          `E_UNKNOWN_BUNDLE: unknown bundle "${bundle}" in GOOGLE_OPTIONAL_SCOPES${hint ? ` — did you mean "${hint}"?` : ''}. Nothing written.`,
        );
        process.exitCode = 1;
        return;
      }
    }
    legacyProfile = { bundles };
  }

  const filePath = configFilePath(env);
  const before = loadConfigFile(filePath);
  // Merge per-alias: env owns the alias set and emails, but file-only fields
  // (scopeProfile, admin) survive for retained aliases — mirroring runtime
  // precedence, where unset GOOGLE_ADMIN_ACCOUNTS preserves file admin flags.
  const existing = before?.accounts ?? {};
  const dropped = Object.keys(existing).filter((a) => !(a in desired));
  for (const [alias, entry] of Object.entries(desired)) {
    const prev = existing[alias];
    if (legacyProfile) entry.scopeProfile = 'legacy-global';
    else if (prev?.scopeProfile) entry.scopeProfile = prev.scopeProfile;
    if (adminAliases.length > 0) {
      if (adminAliases.includes(alias)) entry.admin = true;
    } else if (prev?.admin) {
      entry.admin = true;
    }
  }
  const beforeAccounts = JSON.stringify(existing);
  const beforeProfiles = JSON.stringify(before?.scopeProfiles ?? {});
  const desiredProfiles = legacyProfile
    ? { ...(before?.scopeProfiles ?? {}), 'legacy-global': legacyProfile }
    : (before?.scopeProfiles ?? {});
  if (beforeAccounts === JSON.stringify(desired) && beforeProfiles === JSON.stringify(desiredProfiles)) {
    console.log(`${filePath} already matches the environment — nothing to do.`);
    return;
  }

  mutateConfigFile((current) => {
    current.version = current.version || CONFIG_VERSION;
    current.accounts = desired;
    if (legacyProfile) current.scopeProfiles = desiredProfiles;
    return current;
  }, filePath);

  if (dropped.length > 0) {
    console.error(`Dropping ${dropped.length} alias(es) present in config.json but absent from GOOGLE_ACCOUNTS.`);
  }
  console.log(`Wrote ${filePath}:`);
  console.log(`  accounts before: ${beforeAccounts}`);
  console.log(`  accounts after:  ${JSON.stringify(desired)}`);
  console.log('Environment variables were NOT modified; while GOOGLE_ACCOUNTS is set, env still wins.');
}
