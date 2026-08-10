import fs from 'node:fs';
import path from 'node:path';

// Fetches the Discovery snapshot into discovery/ (gitignored) — npm run gen:discovery; feeds gen:tools, re-run on Google API revisions.

interface Api {
  id: string;
  version: string;
}

const APIS: Api[] = [
  { id: 'admin', version: 'datatransfer_v1' },
  { id: 'admin', version: 'directory_v1' },
  { id: 'admin', version: 'reports_v1' },
  { id: 'alertcenter', version: 'v1beta1' },
  { id: 'appsmarket', version: 'v2' },
  { id: 'calendar', version: 'v3' },
  { id: 'chat', version: 'v1' },
  { id: 'classroom', version: 'v1' },
  { id: 'cloudidentity', version: 'v1' },
  { id: 'cloudsearch', version: 'v1' },
  { id: 'docs', version: 'v1' },
  { id: 'drive', version: 'v2' },
  { id: 'drive', version: 'v3' },
  { id: 'driveactivity', version: 'v2' },
  { id: 'drivelabels', version: 'v2' },
  { id: 'forms', version: 'v1' },
  { id: 'gmail', version: 'v1' },
  { id: 'gmailpostmastertools', version: 'v1' },
  { id: 'groupsmigration', version: 'v1' },
  { id: 'groupssettings', version: 'v1' },
  { id: 'keep', version: 'v1' },
  { id: 'licensing', version: 'v1' },
  { id: 'meet', version: 'v2' },
  { id: 'people', version: 'v1' },
  { id: 'reseller', version: 'v1' },
  { id: 'script', version: 'v1' },
  { id: 'searchconsole', version: 'v1' },
  { id: 'sheets', version: 'v4' },
  { id: 'slides', version: 'v1' },
  { id: 'tasks', version: 'v1' },
  { id: 'vault', version: 'v1' },
  { id: 'workspaceevents', version: 'v1' },
];

// Not fetchable: gsuiteaddons v1 (discovery endpoint requires auth), Marketplace SDK
// (Cloud Console config, not a REST API), CalDAV (IETF protocol). Tracked in MANIFEST.md.
const NO_DISCOVERY: Array<{ name: string; reason: string }> = [
  { name: 'gsuiteaddons v1', reason: 'discovery endpoint requires an authenticated, API-enabled project' },
  { name: 'Workspace Marketplace SDK', reason: 'configured in Cloud Console; not a discovery-backed REST API' },
  { name: 'CalDAV', reason: 'IETF protocol (RFC 4791); no Google discovery document' },
];

const OUT_DIR = path.join(process.cwd(), 'discovery');
const TIMEOUT_MS = 15_000;

function countMethods(node: unknown): number {
  if (typeof node !== 'object' || node === null) return 0;
  const record = node as Record<string, unknown>;
  let count = 'httpMethod' in record ? 1 : 0;
  for (const value of Object.values(record)) count += countMethods(value);
  return count;
}

async function fetchDoc(api: Api): Promise<Record<string, unknown>> {
  const urls = [
    `https://www.googleapis.com/discovery/v1/apis/${api.id}/${api.version}/rest`,
    `https://${api.id}.googleapis.com/$discovery/rest?version=${api.version}`,
  ];
  let lastError = '';
  for (const url of urls) {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return (await res.json()) as Record<string, unknown>;
    lastError = `${url} -> HTTP ${res.status}`;
  }
  throw new Error(`No discovery document for ${api.id}:${api.version} (${lastError})`);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows: Array<{ api: Api; file: string; methods: number; schemas: number; revision: string }> = [];
  const failures: string[] = [];

  for (const api of APIS) {
    const label = `${api.id}:${api.version}`;
    try {
      const doc = await fetchDoc(api);
      const file = `${api.id}.${api.version}.json`;
      fs.writeFileSync(path.join(OUT_DIR, file), `${JSON.stringify(doc, null, 2)}\n`);
      rows.push({
        api,
        file,
        methods: countMethods(doc.resources) + countMethods(doc.methods),
        schemas: Object.keys((doc.schemas as object | undefined) ?? {}).length,
        revision: String(doc.revision ?? 'unknown'),
      });
      console.log(`ok       ${label} (${rows[rows.length - 1].methods} methods, rev ${rows[rows.length - 1].revision})`);
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`);
      console.error(`FAILED   ${label}: ${(error as Error).message}`);
    }
  }

  const totalMethods = rows.reduce((sum, r) => sum + r.methods, 0);
  const date = new Date().toISOString().slice(0, 10);
  const manifest = [
    '# Google Workspace API Discovery — Snapshot Manifest',
    '',
    `Generated: ${date} by \`npm run gen:discovery\`.`,
    'Source: Google API Discovery Service (central endpoint, per-service `$discovery` fallback).',
    '',
    '| Discovery id + version | #methods | #schemas | Revision | File |',
    '|---|---:|---:|---|---|',
    ...rows.map((r) => `| ${r.api.id}:${r.api.version} | ${r.methods} | ${r.schemas} | ${r.revision} | \`${r.file}\` |`),
    '',
    `Total: ${rows.length} documents, ${totalMethods} methods.`,
    '',
    '## No discovery document',
    '',
    ...NO_DISCOVERY.map((n) => `- ${n.name} — ${n.reason}`),
    '',
  ];
  if (failures.length > 0) manifest.push('## Failures', '', ...failures.map((f) => `- ${f}`), '');
  fs.writeFileSync(path.join(OUT_DIR, 'MANIFEST.md'), `${manifest.join('\n')}`);

  console.log(`\n${rows.length}/${APIS.length} documents, ${totalMethods} methods total.`);
  if (failures.length > 0) {
    console.error(`${failures.length} failure(s) — see above.`);
    process.exitCode = 1;
  }
}

await main();
