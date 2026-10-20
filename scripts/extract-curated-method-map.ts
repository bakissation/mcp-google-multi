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
// Check (CI): npx tsx scripts/extract-curated-method-map.ts --check
// (compares the freshly extracted map against BOTH committed copies of
// CURATED_METHOD_TOOLS, gen-config.ts's hand-maintained source and
// method-map.ts's generated mirror, structurally, ids and name sets, not
// as text, so quote-style differences between the two are not false
// positives, but a drift between the TWO COMMITTED COPIES themselves
// -- regenerating one and forgetting the other -- is caught too; exits
// non-zero on any drift)
//
// Method: for each server.registerTool(...) / registerHostFileTool(...)
// call in a curated tools file, find every local client binding reachable
// from that handler: a `const x = fooClient({...})` call, OR a function
// parameter typed as a known googleapis client class (e.g.
// `sourceDrive: drive_v3.Drive`), which is how a curated tool's own helper
// functions (shareAndCopy, downloadAndUpload in drive.ts) receive their
// client instead of calling the factory directly. When the handler (or a
// helper it calls) invokes a LOCALLY DEFINED function or arrow-function
// const by name, that callable's own body is walked too (with its own
// bindings), recursively, so a call several helper functions deep still
// attributes back to the curated tool that started the chain. A helper
// parameter with NO type annotation at all (so typePrefixOf cannot name
// its client) is still resolved when the call site passes an identifier
// already bound in the CALLER's own bindings, by propagating that
// resolved prefix onto the matching parameter position. Every call of the
// shape `x.a.b(...)` (two or more property accesses) on a resolved
// binding is then resolved to the real Discovery method id by matching
// its own method-path suffix against every known method id (curated AND
// generated), since a client factory's own prefix does not always equal
// the Discovery doc's id prefix (e.g. the admin.ts curated tools share
// one `adminClient` factory across the directory/reports/datatransfer
// sub-APIs, whose Discovery ids use their own prefixes).
//
// A call whose suffix matches more than one method id (the SAME suffix
// shared by unrelated services, e.g. "spaces.create" is both
// chat.spaces.create and meet.spaces.create) is narrowed by the call's
// own resolved client prefix first; if that still does not leave exactly
// one candidate (the prefix itself is ambiguous across sub-APIs, as
// admin.ts's one adminClient factory is across directory/reports/
// datatransfer), it is reported rather than silently resolved to a guess
// or silently dropped. A call that still does not resolve to exactly one
// method id, or that resolves but is not a curated method (a curated
// tool calling a generated-only method as a secondary step, the
// EXTRA_METHOD_TOOLS case), is only acceptable when it is a READ (by
// looksLikeWrite, the method id's own last-segment verb) or already
// listed in EXTRA_METHOD_TOOLS; an unresolved, ambiguous, or extra WRITE
// call that is neither is a drift-check failure, since a silently-dropped
// write call is exactly the gap that let drive_transfer's own helper
// calls go unattributed before.
//
// This check is best-effort, not exhaustive: it follows a direct call,
// a call inside a top-level helper (function declaration or arrow-
// function const) the handler invokes BY NAME, and a parameter resolved
// either by its type annotation or by propagating the caller's own
// binding at the call site. It does NOT follow a client re-exported
// under an alias, a destructured method reference
// (`const { create } = drive.files; create(...)`), bracket-notation
// access (`drive.files['create'](...)`), or a helper defined in or
// imported from another file. A curated tool using any of those shapes
// needs its own review, the same as a genuinely new Discovery method
// call would.
import ts from 'typescript';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CURATED_METHOD_IDS, CURATED_METHOD_TOOLS as GEN_CONFIG_CURATED_METHOD_TOOLS } from './gen-config.js';
import {
  CURATED_METHOD_TOOLS as METHOD_MAP_CURATED_METHOD_TOOLS,
  GENERATED_METHOD_TOOLS,
} from '../src/tools/generated/method-map.js';
import { EXTRA_METHOD_TOOLS } from '../src/tools/google-api.js';

// Read verbs by Google's REST naming convention, checked against the
// Discovery method id's OWN last dot segment, not a snake-cased tool
// name: inferCud (src/registry.ts) works on an underscore-joined name,
// where a compound word like "sendAs" mangles into "send_as" and its
// "send" segment falsely matches the CREATE_VERB regex there. This is a
// narrower, offline-only proxy for cudFromMethod's real httpMethod check
// (src/discovery-client.ts), good enough to tell a read from a write
// without needing the Discovery doc at script-run time.
// "watch" is deliberately NOT a read verb here even though it sounds
// passive: *.watch registers a push channel (write-control's
// PUSH_REGISTRATION_RE), a privileged write by Google's own httpMethod
// (POST), not something safe to let through unreviewed.
const READ_VERB_PREFIX = /^(get|list|search|query|lookup|count|batchGet|generateIds|export|download|inspect|check|suggest)/i;
export function looksLikeWrite(methodId: string): boolean {
  const lastSegment = methodId.split('.').pop() ?? '';
  return !READ_VERB_PREFIX.test(lastSegment);
}

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

export interface RawCall {
  tool: string;
  methodPath: string; // "<factoryPrefix>.<a>.<b>..."
}

interface Callable {
  params: readonly ts.ParameterDeclaration[];
  body: ts.Node;
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

// Every top-level callable in the file a handler or helper might invoke by
// name: a `function foo(...) {}` declaration, or a `const foo = (...) =>
// {}` / `const foo = async (...) => {}` arrow-function const (the shape
// shareAndCopy/downloadAndUpload could just as easily have used).
function topLevelCallables(sf: ts.SourceFile): Map<string, Callable> {
  const out = new Map<string, Callable>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      out.set(stmt.name.text, { params: stmt.parameters, body: stmt.body });
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) {
          out.set(decl.name.text, { params: init.parameters, body: init.body });
        }
      }
    }
  }
  return out;
}

// Bindings derivable from the callable's OWN declaration alone: typed
// parameters, plus any local `const x = fooClient(...)` inside its body.
function declaredBindingsOf(callable: Callable): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const p of callable.params) {
    if (ts.isIdentifier(p.name)) {
      const prefix = typePrefixOf(p.type);
      if (prefix) bindings[p.name.text] = prefix;
    }
  }
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      const prefix = factoryPrefixOf(n.initializer);
      if (prefix) bindings[n.name.text] = prefix;
    }
    ts.forEachChild(n, collect);
  };
  collect(callable.body);
  return bindings;
}

export function extractFromSource(file: string, text: string): RawCall[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: RawCall[] = [];
  const callables = topLevelCallables(sf);

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
          } else if (parts.length === 0 && callables.has(cur.text) && !visiting.has(cur.text)) {
            // A call to a locally-defined helper (function OR arrow-const):
            // follow it with ITS OWN bindings, still attributing whatever
            // it calls back to this curated tool. A parameter with no type
            // annotation (so declaredBindingsOf cannot name its client) is
            // still resolved when the matching call argument is an
            // identifier already bound here, by propagating that
            // resolved prefix onto the callee's parameter position.
            const callee = callables.get(cur.text)!;
            const calleeBindings = declaredBindingsOf(callee);
            callee.params.forEach((p, i) => {
              if (!ts.isIdentifier(p.name) || calleeBindings[p.name.text]) return;
              const arg = n.arguments[i];
              if (arg && ts.isIdentifier(arg) && bindings[arg.text]) calleeBindings[p.name.text] = bindings[arg.text];
            });
            const nextVisiting = new Set(visiting);
            nextVisiting.add(cur.text);
            walkBodyForCalls(callee.body, calleeBindings, tool, nextVisiting);
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
      if (nameArg && ts.isStringLiteral(nameArg) && handler && ts.isFunctionLike(handler) && handler.body) {
        const toolName = nameArg.text;
        walkBodyForCalls(handler.body, declaredBindingsOf({ params: handler.parameters, body: handler.body }), toolName, new Set());
      }
    }
    ts.forEachChild(node, walkForRegisterCalls);
  }
  walkForRegisterCalls(sf);
  return out;
}

function extractFromFile(file: string): RawCall[] {
  return extractFromSource(file, fs.readFileSync(file, 'utf8'));
}

/**
 * Narrows a suffix's candidate ids using the call's own resolved client
 * prefix (the first segment of methodPath): a suffix shared by unrelated
 * services (e.g. "spaces.create" is both chat.spaces.create and
 * meet.spaces.create) resolves cleanly once only one candidate's own id
 * prefix matches the client that actually made the call. Returns the
 * single resolved id, or null when zero or more than one candidate
 * remains (a genuinely ambiguous prefix, e.g. admin.ts's one adminClient
 * factory shared across directory/reports/datatransfer, whose Discovery
 * ids use their own prefixes the client prefix cannot match at all).
 */
export function disambiguate(candidates: string[], callPrefix: string): string | null {
  if (candidates.length === 1) return candidates[0];
  const narrowed = candidates.filter((id) => id.split('.')[0] === callPrefix);
  return narrowed.length === 1 ? narrowed[0] : null;
}

function main() {
  const curatedSuffixToId = new Map<string, string[]>();
  for (const id of CURATED_METHOD_IDS) {
    const suffix = id.split('.').slice(1).join('.');
    curatedSuffixToId.set(suffix, [...(curatedSuffixToId.get(suffix) ?? []), id]);
  }
  // Every OTHER known method id (generated-only, not curated): a curated
  // tool calling one as a secondary step is the EXTRA_METHOD_TOOLS case,
  // not an error, as long as it is listed there or is a read.
  const generatedSuffixToId = new Map<string, string[]>();
  for (const id of Object.keys(GENERATED_METHOD_TOOLS)) {
    const suffix = id.split('.').slice(1).join('.');
    generatedSuffixToId.set(suffix, [...(generatedSuffixToId.get(suffix) ?? []), id]);
  }

  const resolved = new Map<string, Set<string>>();
  const unresolved: RawCall[] = [];
  const extraSeen = new Map<string, Set<string>>(); // methodId -> tool names actually observed calling it
  const unexplainedWrites: string[] = [];

  for (const f of CURATED_FILES) {
    for (const call of extractFromFile(`src/tools/${f}.ts`)) {
      const suffix = call.methodPath.split('.').slice(1).join('.');
      const callPrefix = call.methodPath.split('.')[0];
      const curatedCandidates = curatedSuffixToId.get(suffix);
      const resolvedCuratedId = curatedCandidates ? disambiguate(curatedCandidates, callPrefix) : null;
      if (resolvedCuratedId) {
        if (!resolved.has(resolvedCuratedId)) resolved.set(resolvedCuratedId, new Set());
        resolved.get(resolvedCuratedId)!.add(call.tool);
        continue;
      }
      unresolved.push(call);

      if (curatedCandidates && curatedCandidates.length > 1) {
        // The suffix resolved to more than one curated id and the
        // client prefix did not narrow it to exactly one: a genuine
        // ambiguity, not something to guess at silently.
        unexplainedWrites.push(`${call.tool} -> ${call.methodPath} (ambiguous: suffix "${suffix}" matches several curated ids: ${curatedCandidates.join(', ')})`);
        continue;
      }

      const generatedCandidates = generatedSuffixToId.get(suffix);
      const resolvedGeneratedId = generatedCandidates ? disambiguate(generatedCandidates, callPrefix) : null;
      if (resolvedGeneratedId) {
        const id = resolvedGeneratedId;
        if (!extraSeen.has(id)) extraSeen.set(id, new Set());
        extraSeen.get(id)!.add(call.tool);
        const listedTools = EXTRA_METHOD_TOOLS[id] ?? [];
        if (listedTools.includes(call.tool)) continue; // known and reviewed
        const toolName = GENERATED_METHOD_TOOLS[id];
        if (!looksLikeWrite(id)) continue; // a read needs no explicit sign-off
        unexplainedWrites.push(
          `${call.tool} -> ${id} (resolves to generated ${toolName}, a write, but is not in EXTRA_METHOD_TOOLS and is not curated)`,
        );
      } else if (generatedCandidates && generatedCandidates.length > 1) {
        unexplainedWrites.push(`${call.tool} -> ${call.methodPath} (ambiguous: suffix "${suffix}" matches several generated ids: ${generatedCandidates.join(', ')})`);
      } else if (curatedCandidates === undefined && generatedCandidates === undefined && looksLikeWrite(call.methodPath)) {
        // Does not resolve to ANY known method id at all (genuinely not
        // found), and looks like a write by its own last segment: report
        // conservatively rather than guess at a cud it can't actually
        // verify; a read that fails to resolve is left to the existing
        // unresolved/INFO log instead, since there is nothing security-
        // relevant to review there.
        unexplainedWrites.push(`${call.tool} -> ${call.methodPath} (does not resolve to any known curated or generated method id)`);
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

  // EXTRA_METHOD_TOOLS entries the extractor never actually observed: the
  // tool stopped calling that method (or never did), so the entry is
  // stale and should be removed, not trusted forever.
  const staleExtraEntries: string[] = [];
  for (const [id, tools] of Object.entries(EXTRA_METHOD_TOOLS)) {
    const seen = extraSeen.get(id) ?? new Set<string>();
    for (const tool of tools) {
      if (!seen.has(tool)) staleExtraEntries.push(`EXTRA_METHOD_TOOLS["${id}"] claims ${tool} calls it, but no such call was found`);
    }
  }

  if (process.argv.includes('--check')) {
    checkDrift(resolved, unexplainedWrites, staleExtraEntries);
    return;
  }

  if (unexplainedWrites.length > 0) {
    process.stderr.write(`WARNING: unresolved WRITE calls needing review (add to EXTRA_METHOD_TOOLS, or confirm they are reads):\n${unexplainedWrites.map((w) => `  ${w}\n`).join('')}`);
  }
  if (staleExtraEntries.length > 0) {
    process.stderr.write(`WARNING: stale EXTRA_METHOD_TOOLS entries:\n${staleExtraEntries.map((w) => `  ${w}\n`).join('')}`);
  }

  const lines = ['export const CURATED_METHOD_TOOLS: Record<string, string[]> = {'];
  for (const id of [...resolved.keys()].sort()) {
    const names = [...resolved.get(id)!].sort();
    lines.push(`  ${JSON.stringify(id)}: ${JSON.stringify(names)},`);
  }
  lines.push('};');
  process.stdout.write(lines.join('\n') + '\n');
}

// Structural comparison (ids and name sets) against BOTH committed
// copies, not a text diff: gen-config.ts and method-map.ts intentionally
// differ in quote style and spacing, so a text diff would always "drift".
// Comparing against both (not just one) also catches regenerating one
// copy and forgetting the other.
function checkDrift(resolved: Map<string, Set<string>>, unexplainedWrites: string[], staleExtraEntries: string[]): void {
  const problems: string[] = [...unexplainedWrites, ...staleExtraEntries];

  function diffAgainst(label: string, committed: Record<string, string[]>) {
    const extractedIds = new Set(resolved.keys());
    const committedIds = new Set(Object.keys(committed));
    for (const id of extractedIds) {
      if (!committedIds.has(id)) problems.push(`[${label}] + ${id}: ${[...resolved.get(id)!].sort().join(', ')} (missing from the committed map)`);
    }
    for (const id of committedIds) {
      if (!extractedIds.has(id)) problems.push(`[${label}] - ${id}: ${committed[id].join(', ')} (no longer called by any curated tool, per the extractor)`);
    }
    for (const id of extractedIds) {
      if (!committedIds.has(id)) continue;
      const extractedNames = [...resolved.get(id)!].sort();
      const committedNames = [...committed[id]].sort();
      if (JSON.stringify(extractedNames) !== JSON.stringify(committedNames)) {
        problems.push(`[${label}] ~ ${id}: committed [${committedNames.join(', ')}] but extractor found [${extractedNames.join(', ')}]`);
      }
    }
  }
  diffAgainst('gen-config.ts', GEN_CONFIG_CURATED_METHOD_TOOLS);
  diffAgainst('method-map.ts', METHOD_MAP_CURATED_METHOD_TOOLS);

  if (problems.length > 0) {
    process.stderr.write(
      'CURATED_METHOD_TOOLS has drifted from what the curated tool source actually calls:\n' +
        problems.map((p) => `  ${p}\n`).join('') +
        'Run `npx tsx scripts/extract-curated-method-map.ts`, review the output, and update ' +
        'CURATED_METHOD_TOOLS in both scripts/gen-config.ts and src/tools/generated/method-map.ts ' +
        '(or EXTRA_METHOD_TOOLS in src/tools/google-api.ts for a generated-only secondary call).\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('CURATED_METHOD_TOOLS matches what the curated tool source calls: no drift.\n');
}

// Only run when this file is the one invoked directly (npx tsx ...), not
// when extractFromSource is imported elsewhere (e.g. its own unit tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
