import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

// Pin os.release so the WSL detection is deterministic even when the suite
// itself runs under WSL.
const releaseMock = vi.hoisted(() => vi.fn(() => '6.1.0-generic'));
vi.mock('node:os', () => ({ release: releaseMock }));

const fakeChild = () => ({ on: vi.fn(), unref: vi.fn() });

let realPlatform: PropertyDescriptor;

const setPlatform = (p: string) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true });

beforeEach(() => {
  realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  spawnMock.mockReset().mockReturnValue(fakeChild());
  releaseMock.mockReturnValue('6.1.0-generic');
  vi.resetModules();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.restoreAllMocks();
});

describe('openUrl (T7)', () => {
  it('darwin uses open', async () => {
    setPlatform('darwin');
    const { openUrl } = await import('../src/open-url.js');
    openUrl('https://example.com/x?a=1&b=2');
    expect(spawnMock).toHaveBeenCalledWith(
      'open',
      ['https://example.com/x?a=1&b=2'],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('win32 uses powershell -EncodedCommand with the url embedded', async () => {
    setPlatform('win32');
    const { openUrl } = await import('../src/open-url.js');
    openUrl('https://example.com/x?a=1&b=2');
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('powershell.exe');
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decoded).toBe('Start-Process "https://example.com/x?a=1&b=2"');
  });

  it('linux uses xdg-open', async () => {
    setPlatform('linux');
    const { openUrl } = await import('../src/open-url.js');
    openUrl('https://example.com');
    expect(spawnMock.mock.calls[0]?.[0]).toBe('xdg-open');
  });

  it('WSL (linux + microsoft kernel) uses powershell.exe', async () => {
    setPlatform('linux');
    releaseMock.mockReturnValue('5.15.90.1-microsoft-standard-WSL2');
    const { openUrl } = await import('../src/open-url.js');
    openUrl('https://example.com');
    expect(spawnMock.mock.calls[0]?.[0]).toBe('powershell.exe');
  });

  it('a spawn throw is swallowed and openUrl returns void', async () => {
    setPlatform('linux');
    spawnMock.mockImplementation(() => { throw new Error('ENOENT'); });
    const { openUrl } = await import('../src/open-url.js');
    expect(() => openUrl('https://example.com')).not.toThrow();
  });

  it('detaches and unrefs the child so the parent never blocks', async () => {
    setPlatform('linux');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { openUrl } = await import('../src/open-url.js');
    openUrl('https://example.com');
    expect(child.unref).toHaveBeenCalled();
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
