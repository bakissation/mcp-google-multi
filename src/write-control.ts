import type { Cud } from './registry.js';

export type Profile = 'read-only' | 'safe-writes' | 'full-writes';

export interface Policy {
  profile: Profile;
  readOnly: boolean;
  allow: string[];
  deny: string[];
}

interface ToolRef {
  name: string;
  service: string;
  cud: Cud;
}

const PROFILES: Profile[] = ['read-only', 'safe-writes', 'full-writes'];

function parseGlobs(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function resolvePolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  const raw = (env.GOOGLE_PROFILE ?? 'read-only').trim() as Profile;
  return {
    profile: PROFILES.includes(raw) ? raw : 'read-only',
    readOnly: /^(1|true|yes)$/i.test(env.GOOGLE_READ_ONLY ?? ''),
    allow: parseGlobs(env.GOOGLE_WRITE_ALLOW),
    deny: parseGlobs(env.GOOGLE_WRITE_DENY),
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function candidates(tool: ToolRef): string[] {
  const op = tool.name.includes('_') ? tool.name.slice(tool.name.indexOf('_') + 1) : tool.name;
  return [`${tool.service}:${tool.cud}`, `${tool.service}:${op}`];
}

function matchesAny(tool: ToolRef, globs: string[]): boolean {
  if (globs.length === 0) return false;
  const cands = candidates(tool);
  return globs.some((g) => {
    const re = globToRegExp(g);
    return cands.some((c) => re.test(c));
  });
}

function profileAllows(profile: Profile, cud: Cud): boolean {
  if (profile === 'full-writes') return true;
  if (profile === 'safe-writes') return cud === 'create' || cud === 'update';
  return false;
}

export function isAllowed(tool: ToolRef, policy: Policy): boolean {
  if (tool.cud === 'read') return true;
  if (policy.readOnly) return false;
  if (matchesAny(tool, policy.deny)) return false;
  if (matchesAny(tool, policy.allow)) return true;
  return profileAllows(policy.profile, tool.cud);
}

export function writeDisabledResult(tool: ToolRef, policy: Policy) {
  const envelope = {
    error: 'write_disabled',
    message: `"${tool.name}" (${tool.cud}) is disabled by the current write-control policy (profile: ${policy.profile}${policy.readOnly ? ', GOOGLE_READ_ONLY=true' : ''}).`,
    hint: `Enable via GOOGLE_PROFILE=safe-writes|full-writes, or GOOGLE_WRITE_ALLOW="${tool.service}:*".`,
    retriable: false,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    isError: true as const,
  };
}

export function describePolicy(policy: Policy): string {
  return `profile=${policy.profile} readOnly=${policy.readOnly} allow=[${policy.allow.join(', ')}] deny=[${policy.deny.join(', ')}]`;
}
