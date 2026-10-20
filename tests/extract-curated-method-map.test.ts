import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { extractFromSource } from '../scripts/extract-curated-method-map.js';

// LOW (round 4): the extractor only followed a `function foo(...) {}`
// declaration whose parameters carried a recognised client TYPE
// ANNOTATION (e.g. `sourceDrive: drive_v3.Drive`). Two real gaps this
// missed, found while hardening the check: an arrow-function const
// helper (`const foo = async (...) => {...}`, a shape the codebase does
// not currently use but could), and a helper parameter typed `any` (or
// with no annotation at all) that receives an already-bound client from
// its caller, which drive.ts's gmail.ts's resolveReply/readBatch
// (`gmail: any`) both actually do: the extractor silently dropped every
// Discovery method those two helpers call.
describe('extractFromSource: arrow-function helpers and untyped client params', () => {
  it('follows a call into an arrow-function const helper', () => {
    const src = `
      server.registerTool('drive_thing', {}, async ({ account }) => {
        const drive = driveClient({ version: 'v3', auth });
        await helper(drive, account);
      });
      const helper = async (sourceDrive: drive_v3.Drive, account: string) => {
        await sourceDrive.files.copy({ fileId: 'x' });
      };
    `;
    const calls = extractFromSource('fixture.ts', src);
    expect(calls).toContainEqual({ tool: 'drive_thing', methodPath: 'drive.files.copy' });
  });

  it('resolves an untyped (any) helper parameter by propagating the caller\'s own bound client at the call site', () => {
    const src = `
      server.registerTool('gmail_thing', {}, async ({ account }) => {
        const gmail = gmailClient({ version: 'v1', auth });
        await resolveReply(gmail, account);
      });
      export async function resolveReply(gmail: any, account: string) {
        await gmail.users.messages.get({ id: 'x' });
      }
    `;
    const calls = extractFromSource('fixture.ts', src);
    expect(calls).toContainEqual({ tool: 'gmail_thing', methodPath: 'gmail.users.messages.get' });
  });

  it('the real codebase gaps this was written for: resolveReply and readBatch (both gmail: any) in gmail.ts', () => {
    const calls = extractFromSource('src/tools/gmail.ts', fs.readFileSync('src/tools/gmail.ts', 'utf8'));
    const bySource = (tool: string) => calls.some((c) => c.tool === tool && c.methodPath === 'gmail.users.messages.get');
    expect(bySource('gmail_send')).toBe(true);
    expect(bySource('gmail_create_draft')).toBe(true);
    expect(bySource('gmail_read_batch')).toBe(true);
  });
});
