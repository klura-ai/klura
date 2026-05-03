import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { KLURA_DIR } from '../paths';

const BIN_DIR = path.join(KLURA_DIR, 'bin');
const CLOUDFLARED_CANDIDATES = [
  '/opt/homebrew/bin/cloudflared',
  '/usr/local/bin/cloudflared',
  '/usr/bin/cloudflared',
  '/bin/cloudflared',
] as const;

function platformArch(): string {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return `${platform}-${arch}`;
}

function downloadUrl(): string {
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${platformArch()}`;
}

function findSystemCloudflared(): string | null {
  for (const candidate of CLOUDFLARED_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function finishDownload(file: fs.WriteStream, resolve: () => void): void {
  file.close();
  resolve();
}

function downloadFile(url: string, localPath: string, redirects = 0): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = (nextUrl: string, nextRedirects: number): void => {
      if (nextRedirects > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      https
        .get(nextUrl, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            request(res.headers.location, nextRedirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(localPath);
          res.pipe(file);
          file.on('finish', finishDownload.bind(null, file, resolve));
          file.on('error', reject);
        })
        .on('error', reject);
    };
    request(url, redirects);
  });
}

async function ensureCloudflared(): Promise<string> {
  const found = findSystemCloudflared();
  if (found) return found;

  const localPath = path.join(BIN_DIR, 'cloudflared');
  if (fs.existsSync(localPath)) return localPath;

  console.error('[tunnel] Downloading cloudflared...');
  fs.mkdirSync(BIN_DIR, { recursive: true });

  await downloadFile(downloadUrl(), localPath);

  fs.chmodSync(localPath, 0o700);
  console.error('[tunnel] cloudflared downloaded');
  return localPath;
}

import type { Tunnel } from './interface';

export async function openTunnel(localPort: number): Promise<Tunnel> {
  const bin = await ensureCloudflared();
  const proc: ChildProcess = spawn(bin, ['tunnel', '--url', `http://localhost:${localPort}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise<Tunnel>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('cloudflared tunnel did not produce URL within 15s'));
    }, 15000);

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(stderr);
      if (match) {
        clearTimeout(timeout);
        resolve({
          url: match[0],
          kill: () => {
            proc.kill();
          },
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`cloudflared exited with code ${code}`));
    });
  });
}
