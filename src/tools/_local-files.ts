import * as fs from 'fs';
import * as path from 'path';

// path.basename() is a traversal guard — a caller-supplied filename must never escape savePath.
export function prepareLocalDest(savePath: string, filename: string): string {
  const dest = path.join(savePath, path.basename(filename));
  fs.mkdirSync(savePath, { recursive: true });
  return dest;
}

// fs.createReadStream() reports an unopenable path as an async 'error' EVENT;
// with no listener attached, that single event kills the whole process — fatal
// for the shared HTTP transport. Opening the fd first turns the open-failure
// class (ENOENT/EACCES/...) into a normal rejection the caller's try/catch can
// map to an error envelope.
export async function openLocalReadStream(localPath: string): Promise<fs.ReadStream> {
  const handle = await fs.promises.open(localPath, 'r');
  // open() succeeds on a directory; fail it here rather than as an async read error.
  if ((await handle.stat()).isDirectory()) {
    await handle.close();
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${localPath}'`), {
      code: 'EISDIR',
      path: localPath,
    });
  }
  const stream = handle.createReadStream();
  // Mid-read errors still reach the consumer through its own listeners; this
  // one only closes the unhandled-'error' crash path.
  stream.on('error', () => {});
  return stream;
}
