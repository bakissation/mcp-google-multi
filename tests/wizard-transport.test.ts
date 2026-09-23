import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolRegistry } from '../src/registry.js';

// S1.20: the wizard's transport seams. applyFileEntry is hard-mocked to THROW:
// if any path under test reaches it over HTTP, the test fails loudly instead
// of editing real client configs on the dev machine.
vi.mock('../src/client-config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/client-config.js')>();
  return {
    ...mod,
    applyFileEntry: vi.fn(() => {
      throw new Error('applyFileEntry must never run over HTTP');
    }),
  };
});

import { registerAccountWizardTools, setWizardHttpConsent } from '../src/tools/account-wizard.js';
import { applyFileEntry } from '../src/client-config.js';

type Handler = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function captureHandlers(): { handlers: Record<string, Handler>; registry: ToolRegistry; server: McpServer } {
  const handlers: Record<string, Handler> = {};
  const registry = {
    registerMeta: (name: string, _cfg: unknown, h: Handler) => {
      handlers[name] = h;
    },
  } as unknown as ToolRegistry;
  const server = { server: { getClientCapabilities: () => undefined }, sendToolListChanged: vi.fn() } as unknown as McpServer;
  registerAccountWizardTools(registry, server);
  return { handlers, registry, server };
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MCP_TRANSPORT', 'MCP_PUBLIC_URL', 'GOOGLE_ACCOUNTS']) savedEnv[k] = process.env[k];
  process.env.GOOGLE_CLIENT_ID = 'wizard-test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'wizard-test-secret';
  delete process.env.GOOGLE_ACCOUNTS;
});
afterEach(() => {
  setWizardHttpConsent(null);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.clearAllMocks();
});

describe('runConsent over HTTP (S1.20)', () => {
  it('account_reauth hands out the minted consent URL up front and never binds a loopback', async () => {
    const { handlers } = captureHandlers();
    const minted: string[] = [];
    setWizardHttpConsent({
      mintConsentUrl: (alias) => {
        minted.push(alias);
        return `https://mcp.example.com/authorize?flow=alias_reauth&alias=${alias}`;
      },
    });
    const res = await handlers.account_reauth({ alias: 'test' });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('https://mcp.example.com/authorize?flow=alias_reauth&alias=test');
    expect(text).toContain('stored server-side');
    expect(minted).toEqual(['test']);
  });

  it('a mint failure surfaces as a clean envelope, not a hang', async () => {
    const { handlers } = captureHandlers();
    setWizardHttpConsent({
      mintConsentUrl: () => {
        throw new Error('mint backend down');
      },
    });
    const res = await handlers.account_reauth({ alias: 'test' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('internal');
  });
});

describe('account_add refresh nudge (S1.10-A)', () => {
  it('a successful add fires sendToolListChanged so clients re-fetch the live enums', async () => {
    const { handlers, server } = captureHandlers();
    setWizardHttpConsent({ mintConsentUrl: (alias) => `https://mcp.example.com/authorize?flow=alias_reauth&alias=${alias}` });
    const res = await handlers.account_add({ alias: 'fresh', email: 'fresh@x.example' });
    expect(res.isError).toBeUndefined();
    expect((server as unknown as { sendToolListChanged: ReturnType<typeof vi.fn> }).sendToolListChanged).toHaveBeenCalled();
  });
});

describe('account_write_config over HTTP (S1.20)', () => {
  it('write:true never touches the filesystem: snippet only, with the refusal named', async () => {
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_PUBLIC_URL = 'https://mcp.example.com';
    const { handlers } = captureHandlers();
    const res = await handlers.account_write_config({ write: true });
    expect(res.isError).toBeUndefined();
    expect(applyFileEntry).not.toHaveBeenCalled();
    // the CLI-managed client (claude-code) keeps its command form; every
    // file-based target explains the refusal instead of writing
    expect(res.content[0].text).toMatch(/ignored over HTTP|run\n/);
  });

  it('stdio write:true still reaches applyFileEntry (mocked here, so it throws into the envelope)', async () => {
    delete process.env.MCP_TRANSPORT;
    const { handlers } = captureHandlers();
    const res = await handlers.account_write_config({ write: true, client: 'claude-desktop' });
    // the mock throws, proving the stdio path DID attempt the write
    expect(applyFileEntry).toHaveBeenCalled();
    expect(res.isError).toBe(true);
  });
});
