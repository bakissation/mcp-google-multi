import { spawn } from 'node:child_process';
import { release } from 'node:os';

const isWsl = (): boolean =>
  process.platform === 'linux' && release().toLowerCase().includes('microsoft');

// Best-effort browser launch. Never throws, never blocks, writes nothing to
// the parent's stdio — the caller has already printed the URL as the fallback.
export function openUrl(url: string): void {
  try {
    let cmd: string;
    let args: string[];
    if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (process.platform === 'win32' || isWsl()) {
      const encoded = Buffer.from(`Start-Process "${url}"`, 'utf16le').toString('base64');
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Headless/odd platforms: the printed URL is the supported path.
  }
}
