export type Toolsets = 'all' | Set<string>;

export function getToolsets(env: NodeJS.ProcessEnv = process.env): Toolsets {
  const parts = (env.GOOGLE_TOOLSETS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0 || parts.includes('all')) return 'all';
  return new Set(parts);
}

export function toolsetEnabled(toolsets: Toolsets, service: string): boolean {
  return toolsets === 'all' || toolsets.has(service);
}
