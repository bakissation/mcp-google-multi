import fs from 'node:fs';
import path from 'node:path';
import { buildMethodIndex, cudFromMethod, type DiscoveryMethod, type DiscoveryParam } from '../src/discovery-client.js';
import type { Cud } from '../src/registry.js';
import { CURATED_METHOD_IDS, CUD_OVERRIDES, DESCRIPTION_OVERRIDES, GEN_APIS, NAME_OVERRIDES, type GenApi } from './gen-config.js';

// Coverage generator: discovery snapshot -> src/tools/generated/<service>.ts.
// Usage: npm run gen:tools [service ...]   (no args = all configured services)
// Output is deterministic; generated files are never hand-edited.

const MAX_TOOL_NAME = 64;
const RESERVED_FIELDS = new Set(['account', 'body']);

interface DiscoveryDocJson {
  baseUrl?: string;
  rootUrl?: string;
  servicePath?: string;
  resources?: Record<string, unknown>;
  methods?: Record<string, unknown>;
  schemas?: Record<string, { properties?: Record<string, unknown> }>;
}

interface RawMethod {
  request?: { $ref?: string };
}

export interface ToolPlan {
  name: string;
  cud: Cud;
  description: string;
  method: DiscoveryMethod;
  params: Array<{ field: string; api: string; location: 'path' | 'query' }>;
  bodyRef?: string;
  bodyProperties: string[];
}

export interface ServiceReport {
  service: string;
  emitted: number;
  skippedCurated: number;
  overrideHits: number;
  looseParams: string[];
}

const CURATED = new Set(CURATED_METHOD_IDS);

export function snakeCase(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function toolNameFromId(service: string, methodId: string): string {
  const override = NAME_OVERRIDES[methodId];
  if (override) return override;
  const tail = methodId.split('.').slice(1).map(snakeCase).join('_');
  return `${service}_${tail}`;
}

function stringLiteral(value: string): string {
  return JSON.stringify(value);
}

function describeText(text: string | undefined, fallback: string): string {
  const first = (text ?? '').split('\n')[0].trim();
  return (first || fallback).slice(0, 200);
}

function paramZod(name: string, param: DiscoveryParam, looseParams: string[], context: string): string {
  const p = param as DiscoveryParam & { enum?: string[]; repeated?: boolean };
  let inner: string;
  switch (p.type) {
    case 'string':
      inner = Array.isArray(p.enum) && p.enum.length > 0 ? `z.enum(${JSON.stringify(p.enum)})` : 'z.string()';
      break;
    case 'integer':
    case 'number':
      inner = 'z.number()';
      break;
    case 'boolean':
      inner = 'coerceBoolean';
      break;
    default:
      looseParams.push(`${context}.${name} (type ${p.type ?? 'unknown'})`);
      inner = 'z.any()';
  }
  if (p.repeated) inner = `coerceArray(${inner})`;
  let out = inner;
  const desc = describeText(p.description, '');
  if (desc) out += `.describe(${stringLiteral(desc)})`;
  if (!p.required) out += '.optional()';
  return out;
}

export function planTools(doc: DiscoveryDocJson, api: GenApi, alreadyEmitted: Set<string> = new Set()): { plans: ToolPlan[]; report: ServiceReport } {
  const index = buildMethodIndex(doc, api.service).sort((a, b) => a.id.localeCompare(b.id));
  const report: ServiceReport = { service: api.service, emitted: 0, skippedCurated: 0, overrideHits: 0, looseParams: [] };
  const rawById = new Map<string, RawMethod>();
  const walkRaw = (node: { resources?: Record<string, unknown>; methods?: Record<string, unknown> }) => {
    for (const m of Object.values(node.methods ?? {})) {
      const raw = m as RawMethod & { id?: string };
      if (raw.id) rawById.set(raw.id, raw);
    }
    for (const r of Object.values(node.resources ?? {})) walkRaw(r as { resources?: Record<string, unknown> });
  };
  walkRaw(doc as { resources?: Record<string, unknown>; methods?: Record<string, unknown> });

  const plans: ToolPlan[] = [];
  for (const method of index) {
    if (CURATED.has(method.id)) {
      report.skippedCurated += 1;
      continue;
    }
    // The same method id can appear in several docs of one service
    // (admin.channels.stop ships in directory_v1 and reports_v1) — emit once.
    if (alreadyEmitted.has(method.id)) continue;
    alreadyEmitted.add(method.id);
    const name = toolNameFromId(api.service, method.id);
    if (name.length > MAX_TOOL_NAME) {
      throw new Error(`Tool name "${name}" (${name.length} chars) exceeds ${MAX_TOOL_NAME}; add NAME_OVERRIDES["${method.id}"]`);
    }
    const cud = CUD_OVERRIDES[method.id] ?? cudFromMethod(method);
    const description = DESCRIPTION_OVERRIDES[method.id] ?? describeText(method.description, `${method.httpMethod} ${method.id}`);
    if (CUD_OVERRIDES[method.id] || DESCRIPTION_OVERRIDES[method.id] || NAME_OVERRIDES[method.id]) report.overrideHits += 1;

    const params = Object.entries(method.params)
      .map(([apiName, param]) => ({
        apiName,
        param,
        field: RESERVED_FIELDS.has(apiName) ? `${apiName}_` : apiName,
      }))
      .sort((a, b) => {
        const req = Number(Boolean(b.param.required)) - Number(Boolean(a.param.required));
        if (req !== 0) return req;
        const loc = (a.param.location === 'path' ? 0 : 1) - (b.param.location === 'path' ? 0 : 1);
        if (loc !== 0) return loc;
        return a.apiName.localeCompare(b.apiName);
      });

    const bodyRef = rawById.get(method.id)?.request?.$ref;
    const bodyProperties = bodyRef ? Object.keys(doc.schemas?.[bodyRef]?.properties ?? {}).sort() : [];

    plans.push({
      name,
      cud,
      description,
      method,
      params: params.map((p) => ({ field: p.field, api: p.apiName, location: p.param.location })),
      bodyRef,
      bodyProperties,
    });
    report.emitted += 1;
  }

  const seen = new Map<string, string>();
  for (const plan of plans) {
    const existing = seen.get(plan.name);
    if (existing) {
      throw new Error(`Generated name collision "${plan.name}" (${existing} vs ${plan.method.id}); add NAME_OVERRIDES`);
    }
    seen.set(plan.name, plan.method.id);
  }
  return { plans, report };
}

function emitShapeField(field: string, zod: string): string {
  return `      ${/^[a-zA-Z_$][\w$]*$/.test(field) ? field : stringLiteral(field)}: ${zod},`;
}

export function emitService(doc: DiscoveryDocJson, api: GenApi, alreadyEmitted: Set<string> = new Set()): { fileText: string; report: ServiceReport; names: string[] } {
  const { plans, report } = planTools(doc, api, alreadyEmitted);
  const lines: string[] = [
    `export function register${api.service[0].toUpperCase()}${api.service.slice(1)}GeneratedTools(registry: ToolRegistry): void {`,
  ];

  for (const plan of plans) {
    const m = plan.method;
    const shape: string[] = [emitShapeField('account', 'accountField()')];
    for (const p of plan.params) {
      const raw = m.params[p.api];
      shape.push(emitShapeField(p.field, paramZod(p.api, raw, report.looseParams, m.id)));
    }
    if (plan.bodyRef) {
      const propsNote = plan.bodyProperties.length > 0
        ? ` Top-level fields: ${plan.bodyProperties.slice(0, 12).join(', ')}${plan.bodyProperties.length > 12 ? `, +${plan.bodyProperties.length - 12} more` : ''}.`
        : '';
      shape.push(emitShapeField('body', `coerceJson(z.record(z.string(), z.unknown())).describe(${stringLiteral(`${plan.bodyRef} JSON request body.${propsNote}`)})`));
    }
    if (!('fields' in m.params)) {
      shape.push(emitShapeField('fields', `z.string().optional().describe('Response field mask.')`));
    }

    const paramEntries = [...plan.params];
    if (!('fields' in m.params)) paramEntries.push({ field: 'fields', api: 'fields', location: 'query' });

    lines.push(
      '  registerGeneratedTool(registry, {',
      `    name: ${stringLiteral(plan.name)},`,
      `    cud: ${stringLiteral(plan.cud)},`,
      `    description: ${stringLiteral(plan.description)},`,
      `    method: { id: ${stringLiteral(m.id)}, httpMethod: ${stringLiteral(m.httpMethod)}, path: ${stringLiteral(m.path)}, baseUrl: ${stringLiteral(m.baseUrl)}, requiredParams: ${JSON.stringify(m.requiredParams)} },`,
      `    params: ${JSON.stringify(paramEntries)},`,
      `    hasBody: ${plan.bodyRef ? 'true' : 'false'},`,
      '    shape: {',
      ...shape,
      '    },',
      '  });',
    );
  }
  lines.push('}');
  return { fileText: lines.join('\n'), report, names: plans.map((p) => p.name) };
}

// Registration bodies from every doc of a service merge into one file; the
// import list is computed over the merged text so no doc's helpers go missing.
export function buildServiceFile(service: string, registrationBodies: string[]): string {
  const fn = `register${service[0].toUpperCase()}${service.slice(1)}GeneratedTools`;
  const inner = registrationBodies
    .map((b) => b.slice(b.indexOf('{') + 1, b.lastIndexOf('}')).replace(/^\n|\n$/g, ''))
    .filter((b) => b.length > 0)
    .join('\n');
  const body = `export function ${fn}(registry: ToolRegistry): void {\n${inner}\n}\n`;
  const coerceUsed = ['coerceArray', 'coerceBoolean', 'coerceJson'].filter((h) => body.includes(h));
  const header = [
    '// GENERATED by scripts/gen-tools.ts — do not edit. Regenerate: npm run gen:tools',
    "import { z } from 'zod';",
    "import type { ToolRegistry } from '../../registry.js';",
    ...(coerceUsed.length > 0 ? [`import { ${coerceUsed.join(', ')} } from '../_coerce.js';`] : []),
    "import { accountField, registerGeneratedTool } from './_shared.js';",
    '',
  ];
  return `${header.join('\n')}\n${body}`;
}

export function emitBarrel(services: string[]): string {
  const sorted = [...services].sort();
  const lines = [
    '// GENERATED by scripts/gen-tools.ts — do not edit. Regenerate: npm run gen:tools',
    "import type { ToolRegistry } from '../../registry.js';",
    ...sorted.map((s) => `import { register${s[0].toUpperCase()}${s.slice(1)}GeneratedTools } from './${s}.js';`),
    '',
    'export const GENERATED_SERVICES: Array<{ name: string; register: (registry: ToolRegistry) => void }> = [',
    ...sorted.map((s) => `  { name: ${JSON.stringify(s)}, register: register${s[0].toUpperCase()}${s.slice(1)}GeneratedTools },`),
    '];',
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const filter = new Set(process.argv.slice(2));
  const discoveryDir = path.join(process.cwd(), 'discovery');
  const outDir = path.join(process.cwd(), 'src', 'tools', 'generated');
  fs.mkdirSync(outDir, { recursive: true });

  const byService = new Map<string, { docs: Array<{ doc: DiscoveryDocJson; api: GenApi }> }>();
  for (const api of GEN_APIS) {
    if (filter.size > 0 && !filter.has(api.service)) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(discoveryDir, api.file), 'utf-8')) as DiscoveryDocJson;
    const entry = byService.get(api.service) ?? { docs: [] };
    entry.docs.push({ doc, api });
    byService.set(api.service, entry);
  }

  const reports: ServiceReport[] = [];
  const emittedServices: string[] = [];
  for (const [service, entry] of [...byService.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const bodies: string[] = [];
    const serviceReport: ServiceReport = { service, emitted: 0, skippedCurated: 0, overrideHits: 0, looseParams: [] };
    const serviceNames = new Set<string>();
    const serviceMethodIds = new Set<string>();
    for (const { doc, api } of entry.docs) {
      const { fileText, report, names } = emitService(doc, api, serviceMethodIds);
      for (const n of names) {
        if (serviceNames.has(n)) throw new Error(`Cross-document name collision "${n}" in service "${service}"; add NAME_OVERRIDES`);
        serviceNames.add(n);
      }
      serviceReport.emitted += report.emitted;
      serviceReport.skippedCurated += report.skippedCurated;
      serviceReport.overrideHits += report.overrideHits;
      serviceReport.looseParams.push(...report.looseParams);
      bodies.push(fileText);
    }
    if (serviceReport.emitted === 0) {
      console.log(`skip     ${service} (fully curated)`);
      continue;
    }
    fs.writeFileSync(path.join(outDir, `${service}.ts`), buildServiceFile(service, bodies));
    emittedServices.push(service);
    reports.push(serviceReport);
    console.log(`emitted  ${service}: ${serviceReport.emitted} tools (${serviceReport.skippedCurated} curated skips, ${serviceReport.overrideHits} overrides)`);
  }

  if (filter.size === 0) {
    fs.writeFileSync(path.join(outDir, 'index.ts'), emitBarrel(emittedServices));
  }

  const loose = reports.flatMap((r) => r.looseParams);
  if (loose.length > 0) {
    console.log(`\nloose z.any() params (review targets):`);
    for (const l of loose) console.log(`  - ${l}`);
  }
  const total = reports.reduce((sum, r) => sum + r.emitted, 0);
  console.log(`\n${total} generated tools across ${emittedServices.length} services.`);
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]).includes('gen-tools');
if (isDirectRun) await main();
