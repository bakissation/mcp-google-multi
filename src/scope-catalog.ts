// The curated bundle catalog: ONE source of truth consumed by the wizard
// picker, scope observability (#114) hints, and docs. Keys are a frozen
// public API (config.json references them by name) — renames go through
// BUNDLE_ALIASES, never in place.

export interface ScopeProfile {
  includesBase?: boolean; // default true; false = advanced minimal-token escape hatch
  bundles: string[];      // catalog keys (post-alias-resolution); [] = base-only
  admin?: boolean;        // equivalent to bundles including "admin"
}

export interface BundleCatalogEntry {
  scopes: string[];
  description: string;
  risk: 'low' | 'medium' | 'high';
  workspaceOnly?: boolean;
}

export const ADMIN_SCOPES = [
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
];

export const BUNDLE_CATALOG: Record<string, BundleCatalogEntry> = {
  slides: {
    scopes: ['https://www.googleapis.com/auth/presentations'],
    description: 'Create and edit Google Slides presentations.',
    risk: 'low',
  },
  forms: {
    scopes: [
      'https://www.googleapis.com/auth/forms.body',
      'https://www.googleapis.com/auth/forms.responses.readonly',
    ],
    description: 'Build Google Forms and read their responses.',
    risk: 'medium',
  },
  chat: {
    scopes: [
      'https://www.googleapis.com/auth/chat.spaces',
      'https://www.googleapis.com/auth/chat.messages',
      'https://www.googleapis.com/auth/chat.messages.create',
    ],
    description: 'Read and send Google Chat messages and manage spaces (Workspace accounts).',
    risk: 'medium',
  },
  // These extend the always-on gmail service: users.settings.* writes require
  // them (reads already work via gmail.modify); sharing is split out as riskier.
  gmail_settings: {
    scopes: ['https://www.googleapis.com/auth/gmail.settings.basic'],
    description: 'Change mailbox settings: filters, labels, vacation responder.',
    risk: 'medium',
  },
  gmail_settings_sharing: {
    scopes: ['https://www.googleapis.com/auth/gmail.settings.sharing'],
    description: 'Manage forwarding addresses and delegates — can route mail out of the mailbox.',
    risk: 'high',
  },
  classroom: {
    scopes: [
      'https://www.googleapis.com/auth/classroom.courses',
      'https://www.googleapis.com/auth/classroom.coursework.me',
      'https://www.googleapis.com/auth/classroom.coursework.students',
      'https://www.googleapis.com/auth/classroom.courseworkmaterials',
      'https://www.googleapis.com/auth/classroom.rosters',
      'https://www.googleapis.com/auth/classroom.announcements',
      'https://www.googleapis.com/auth/classroom.topics',
    ],
    description: 'Manage Classroom courses, coursework, rosters and announcements.',
    risk: 'medium',
  },
  cloudidentity: {
    scopes: [
      'https://www.googleapis.com/auth/cloud-identity.groups',
      'https://www.googleapis.com/auth/cloud-identity.devices',
    ],
    description: 'Manage Cloud Identity groups and devices across the directory.',
    risk: 'high',
  },
  cloudsearch: {
    scopes: ['https://www.googleapis.com/auth/cloud_search'],
    description: 'Query Google Cloud Search across Workspace content.',
    risk: 'medium',
  },
  vault: {
    scopes: ['https://www.googleapis.com/auth/ediscovery'],
    description: 'Google Vault eDiscovery: matters, holds and exports over the whole domain.',
    risk: 'high',
    workspaceOnly: true,
  },
  keep: {
    scopes: ['https://www.googleapis.com/auth/keep'],
    description: 'Read and edit Google Keep notes.',
    risk: 'low',
  },
  driveactivity: {
    scopes: ['https://www.googleapis.com/auth/drive.activity.readonly'],
    description: 'Read the Drive activity feed (who did what, when).',
    risk: 'low',
  },
  drivelabels: {
    scopes: [
      'https://www.googleapis.com/auth/drive.labels',
      'https://www.googleapis.com/auth/drive.admin.labels',
    ],
    description: 'Manage Drive labels, including admin label taxonomy.',
    risk: 'medium',
  },
  script: {
    scopes: [
      'https://www.googleapis.com/auth/script.projects',
      'https://www.googleapis.com/auth/script.deployments',
      'https://www.googleapis.com/auth/script.processes',
      'https://www.googleapis.com/auth/script.metrics',
    ],
    description: 'Manage Apps Script projects and deployments.',
    risk: 'medium',
  },
  postmaster: {
    scopes: ['https://www.googleapis.com/auth/postmaster.readonly'],
    description: 'Read Gmail Postmaster Tools deliverability data.',
    risk: 'low',
  },
  groupssettings: {
    scopes: ['https://www.googleapis.com/auth/apps.groups.settings'],
    description: 'Change Google Groups settings for the domain.',
    risk: 'medium',
  },
  groupsmigration: {
    scopes: ['https://www.googleapis.com/auth/apps.groups.migration'],
    description: 'Migrate archived messages into Google Groups.',
    risk: 'high',
  },
  licensing: {
    scopes: ['https://www.googleapis.com/auth/apps.licensing'],
    description: 'Assign and revoke Workspace license seats.',
    risk: 'high',
  },
  reseller: {
    scopes: ['https://www.googleapis.com/auth/apps.order'],
    description: 'Manage reseller customer subscriptions and orders.',
    risk: 'high',
  },
  appsmarket: {
    scopes: ['https://www.googleapis.com/auth/appsmarketplace.license'],
    description: 'Read Marketplace app license assignments.',
    risk: 'high',
  },
  admin: {
    scopes: ADMIN_SCOPES,
    description: 'Workspace admin: user directory management and audit reports.',
    risk: 'high',
    workspaceOnly: true,
  },
};

/** One-way soft-rename map (UD5): empty at 6.0.0; the mechanism ships now so a
 * future rename is a deprecation warning, never a breaking config change. */
export const BUNDLE_ALIASES: Record<string, string> = {};

const warnedAliases = new Set<string>();

export function resolveBundleAliases(bundles: string[]): string[] {
  return bundles.map((name) => {
    const target = BUNDLE_ALIASES[name];
    if (!target) return name;
    if (!warnedAliases.has(name)) {
      warnedAliases.add(name);
      process.stderr.write(`WARN: bundle "${name}" is deprecated; use "${target}".\n`);
    }
    return target;
  });
}

/** Closest catalog key for E_UNKNOWN_BUNDLE remediation (edit distance <= 2). */
export function closestBundle(name: string): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const key of Object.keys(BUNDLE_CATALOG)) {
    const d = editDistance(name.toLowerCase(), key);
    if (d < bestDist) {
      bestDist = d;
      best = key;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}
