// Derives, from the curated tool source itself, which Discovery method id
// every curated registration calls. Prints a Record<string, string[]>
// (method id -> every curated tool name that calls it) ready to paste into
// CURATED_METHOD_TOOLS in gen-config.ts after review. This is NOT wired
// into `npm run gen:tools` (a curated tool's own registration is read by a
// person before it ships; this is the check that the hand-maintained map
// still agrees with what curated tools actually call, not a build step).
// Run it in CI as a drift check too (fail if the generated map differs
// from what is committed), since a curated tool that starts calling a new
// Discovery method would otherwise silently drift the map it feeds.
//
// Run: npx tsx scripts/extract-curated-method-map.ts
//
// Method: for each server.registerTool(...) / registerHostFileTool(...)
// call in a curated tools file, find every local client binding reachable
// from that handler: a `const x = fooClient({...})` call, OR a function
// parameter typed as a known googleapis client class (e.g.
// `sourceDrive: drive_v3.Drive`), which is how a curated tool's own helper
// functions (shareAndCopy, downloadAndUpload in drive.ts) receive their
// client instead of calling the factory directly. When the handler (or a
// helper it calls) invokes a LOCALLY DEFINED function by name, that
// function's own body is walked too (with its own bindings), recursively,
// so a call several helper functions deep still attributes back to the
// curated tool that started the chain. Every call of the shape `x.a.b(...)`
// (two or more property accesses) on a resolved binding is then resolved
// to the real Discovery method id by matching its own method-path suffix
// against CURATED_METHOD_IDS, since a client factory's own prefix does not
// always equal the Discovery doc's id prefix (e.g. the admin.ts curated
// tools share one `adminClient` factory across the directory/reports/
// datatransfer sub-APIs, whose Discovery ids use their own prefixes).
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

// googleapis client TYPE names (drive_v3.Drive, gmail_v1.Gmail, ...) are
// conventionally the capitalized service name; this maps the lowercased
// class name to the same prefix a factory-call binding would resolve to,
// for a parameter typed that way instead of initialized from a factory call.
const TYPE_CLASS_TO_PREFIX: Record<string, string> = {
  drive: 'drive',
  gmail: 'gmail',
  calendar: 'calendar',
  sheets: 'sheets',
  docs: 'docs',
  slides: 'slides',
  forms: 'forms',
  people: 'people',
  chat: 'chat',
  meet: 'meet',
  searchconsole: 'searchconsole',
  webmasters: 'webmasters',
  tasks: 'tasks',
  admin: 'admin',
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

// The rightmost identifier of a type reference, e.g. "Drive" from
// `drive_v3.Drive` (a QualifiedName) or plain `Drive`.
function typePrefixOf(typeNode: ts.TypeNode | undefined): string | undefined {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return undefined;
  let name: ts.EntityName = typeNode.typeName;
  while (ts.isQualifiedName(name)) name = name.right;
  return TYPE_CLASS_TO_PREFIX[name.text.toLowerCase()];
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

  // Top-level `async function helper(...) { ... }` declarations in this
  // file, so a call to one from a handler (or from another helper) can be
  // followed into its own body.
  const topLevelFns = new Map<string, ts.FunctionDeclaration>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      topLevelFns.set(stmt.name.text, stmt);
    }
  }

  function bindingsOf(fnLike: ts.FunctionLikeDeclarationBase | ts.FunctionDeclaration): Record<string, string> {
    const bindings: Record<string, string> = {};
    for (const p of fnLike.parameters) {
      if (ts.isIdentifier(p.name)) {
        const prefix = typePrefixOf(p.type);
        if (prefix) bindings[p.name.text] = prefix;
      }
    }
    const body = (fnLike as { body?: ts.Node }).body;
    if (body) {
      const collect = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
          const prefix = factoryPrefixOf(n.initializer);
          if (prefix) bindings[n.name.text] = prefix;
        }
        ts.forEachChild(n, collect);
      };
      collect(body);
    }
    return bindings;
  }

  function walkBodyForCalls(body: ts.Node, bindings: Record<string, string>, tool: string, visiting: Set<string>) {
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const parts: string[] = [];
        let cur: ts.Expression = n.expression;
        while (ts.isPropertyAccessExpression(cur)) {
          parts.unshift(cur.name.text);
          cur = cur.expression;
        }
        if (ts.isIdentifier(cur)) {
          if (bindings[cur.text] && parts.length >= 2) {
            out.push({ tool, methodPath: `${bindings[cur.text]}.${parts.join('.')}` });
          } else if (parts.length === 0 && topLevelFns.has(cur.text) && !visiting.has(cur.text)) {
            // A call to a locally-defined helper (shareAndCopy,
            // downloadAndUpload, ...): follow it with ITS OWN bindings
            // (its typed parameters, its own local factory calls), still
            // attributing whatever it calls back to this curated tool.
            const helper = topLevelFns.get(cur.text)!;
            const nextVisiting = new Set(visiting);
            nextVisiting.add(cur.text);
            walkBodyForCalls(helper.body!, bindingsOf(helper), tool, nextVisiting);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  }

  function walkForRegisterCalls(node: ts.Node) {
    if (isRegisterCall(node)) {
      const call = node as ts.CallExpression;
      const [nameArg, , handler] = call.arguments;
      if (nameArg && ts.isStringLiteral(nameArg) && handler && 'body' in handler && (handler as ts.FunctionLikeDeclarationBase).body) {
        const toolName = nameArg.text;
        const fnLike = handler as unknown as ts.FunctionLikeDeclarationBase;
        walkBodyForCalls(fnLike.body!, bindingsOf(fnLike), toolName, new Set());
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
