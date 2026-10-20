// Derives, from the curated tool source itself, which Discovery method id
// every curated registration calls. Prints a Record<string, string[]>
// (method id -> every curated tool name that calls it) ready to paste into
// CURATED_METHOD_TOOLS in gen-config.ts after review. This is NOT wired
// into `npm run gen:tools` (a curated tool's own registration is read by a
// person before it ships; this is the check that the hand-maintained map
// still agrees with what curated tools actually call, not a build step).
//
// Run: npx tsx scripts/extract-curated-method-map.ts
//
// Method: for each server.registerTool(...) / registerHostFileTool(...)
// call in a curated tools file, find every local `const x = fooClient({...})`
// binding inside that handler (the googleapis client instance), then every
// call of the shape `x.a.b(...)` (two or more property accesses) on that
// binding. The (client-factory prefix).a.b path is then resolved to the
// real Discovery method id by matching its own method-path suffix against
// CURATED_METHOD_IDS, since a client factory's own prefix does not always
// equal the Discovery doc's id prefix (e.g. the admin.ts curated tools
// share one `adminClient` factory across the directory/reports/datatransfer
// sub-APIs, whose Discovery ids use their own prefixes).
import ts from 'typescript';
import fs from 'node:fs';
import { CURATED_METHOD_IDS } from './gen-config.js';

const FACTORY_TO_PREFIX: Record<string, string> = {
  driveClient: 'drive',
  gmailClient: 'gmail',
  calendarClient: 'calendar',
  sheetsClient: 'sheets',
  docsClient: 'docs',
  slidesClient: 'slides',
  formsClient: 'forms',
  peopleClient: 'people',
  chatClient: 'chat',
  meetClient: 'meet',
  searchconsoleClient: 'searchconsole',
  webmastersClient: 'webmasters',
  tasksClient: 'tasks',
  analyticsdataClient: 'analyticsdata',
  analyticsadminClient: 'analyticsadmin',
  adminClient: 'admin',
};

const CURATED_FILES = [
  'drive', 'gmail', 'calendar', 'sheets', 'docs', 'slides', 'forms',
  'contacts', 'chat', 'meet', 'searchconsole', 'tasks', 'analytics', 'admin',
];

interface RawCall {
  tool: string;
  methodPath: string; // "<factoryPrefix>.<a>.<b>..."
}

function factoryPrefixOf(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  return ts.isIdentifier(callee) ? FACTORY_TO_PREFIX[callee.text] : undefined;
}

function isRegisterCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'registerTool') return true;
  // drive.ts / gmail.ts alias server.registerTool to a local function when
  // GOOGLE_LOCAL_FILES / localFiles may be false; same shape, bare identifier.
  return ts.isIdentifier(expr) && expr.text === 'registerHostFileTool';
}

function extractFromFile(file: string): RawCall[] {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: RawCall[] = [];

  function walkForRegisterCalls(node: ts.Node) {
    if (isRegisterCall(node)) {
      const call = node as ts.CallExpression;
      const [nameArg, , handler] = call.arguments;
      if (nameArg && ts.isStringLiteral(nameArg) && handler) {
        const toolName = nameArg.text;
        const localBindings: Record<string, string> = {};
        const collectBindings = (n: ts.Node) => {
          if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
            const prefix = factoryPrefixOf(n.initializer);
            if (prefix) localBindings[n.name.text] = prefix;
          }
          ts.forEachChild(n, collectBindings);
        };
        collectBindings(handler);

        const collectMethodCalls = (n: ts.Node) => {
          if (ts.isCallExpression(n)) {
            const parts: string[] = [];
            let cur: ts.Expression = n.expression;
            while (ts.isPropertyAccessExpression(cur)) {
              parts.unshift(cur.name.text);
              cur = cur.expression;
            }
            if (ts.isIdentifier(cur) && localBindings[cur.text] && parts.length >= 2) {
              out.push({ tool: toolName, methodPath: `${localBindings[cur.text]}.${parts.join('.')}` });
            }
          }
          ts.forEachChild(n, collectMethodCalls);
        };
        collectMethodCalls(handler);
      }
    }
    ts.forEachChild(node, walkForRegisterCalls);
  }
  walkForRegisterCalls(sf);
  return out;
}

function main() {
  const suffixToId = new Map<string, string[]>();
  for (const id of CURATED_METHOD_IDS) {
    const suffix = id.split('.').slice(1).join('.');
    suffixToId.set(suffix, [...(suffixToId.get(suffix) ?? []), id]);
  }

  const resolved = new Map<string, Set<string>>();
  const unresolved: RawCall[] = [];
  for (const f of CURATED_FILES) {
    for (const call of extractFromFile(`src/tools/${f}.ts`)) {
      const suffix = call.methodPath.split('.').slice(1).join('.');
      const candidates = suffixToId.get(suffix);
      if (candidates && candidates.length === 1) {
        const id = candidates[0];
        if (!resolved.has(id)) resolved.set(id, new Set());
        resolved.get(id)!.add(call.tool);
      } else {
        unresolved.push(call);
      }
    }
  }

  const missing = CURATED_METHOD_IDS.filter((id) => !resolved.has(id));
  if (missing.length > 0) {
    process.stderr.write(`WARNING: no curated call found for: ${missing.join(', ')}\n`);
  }
  if (unresolved.length > 0) {
    process.stderr.write(
      `INFO: calls that do not resolve to a CURATED_METHOD_IDS entry (expected when a curated ` +
        `tool also calls a non-curated/generated-only method, e.g. contacts_resolve also calling ` +
        `people.otherContacts.search): ${unresolved.map((u) => `${u.tool}->${u.methodPath}`).join(', ')}\n`,
    );
  }

  const lines = ['export const CURATED_METHOD_TOOLS: Record<string, string[]> = {'];
  for (const id of [...resolved.keys()].sort()) {
    const names = [...resolved.get(id)!].sort();
    lines.push(`  ${JSON.stringify(id)}: ${JSON.stringify(names)},`);
  }
  lines.push('};');
  process.stdout.write(lines.join('\n') + '\n');
}

main();
