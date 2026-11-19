
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FILESIZE_BYTES = 50 * 1024 * 1024;
const MAX_FILESIZE_ARG = '50M';

export class DownloaderService {
  constructor() {
    this.activeDownloads = new Map();
  }

  createTempDir() {
    return path.join(os.tmpdir(), `tgdl-${randomUUID()}`);
  }

  async ensureTempDir(dir) {
    await fs.mkdir(dir, { recursive: true });
  }

  async getFileSize(filePath) {
    try {
      return (await fs.stat(filePath)).size;
    } catch {
      return 0;
    }
  }

  async removeTempDir(dir) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.error('[Downloader] Cleanup error:', err.message);
    }
  }

  killUserDownload(userId) {
    const proc = this.activeDownloads.get(userId);

    if (proc) {
      try {
        proc.kill('SIGKILL');
      } catch {}
      this.activeDownloads.delete(userId);
    }
  }

  downloadVideo(url, userId, options = {}) {
    return this.download(url, userId, {
      ...options,
      audioOnly: false
    });
  }

  downloadAudio(url, userId, options = {}) {
    return this.download(url, userId, {
      ...options,
      audioOnly: true
    });
  }

  async download(url, userId, options = {}) {
    const { audioOnly = false, onProgress = null } = options;
    const tempDir = this.createTempDir();

    await this.ensureTempDir(tempDir);

    const outputTemplate = path.join(
      tempDir,
      audioOnly ? '%(title)s.mp3' : '%(title)s.%(ext)s'
    );

    const args = [
      '--no-playlist',
      '--max-filesize', MAX_FILESIZE_ARG,
      '--restrict-filenames',
      '--no-warnings',
      '--ignore-errors',
      '-o', outputTemplate
    ];

    if (audioOnly) {
      args.push(
        '-f', 'bestaudio/best',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '192K'
      );
    } else {
      args.push(
        '--write-thumbnail',
        '-f',
        'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
      );
    }

    args.push('--print', 'before_dl:%(title)s');
    args.push('--', url);

    const candidates = [
      process.env.YTDLP_PATH,
      '/usr/local/bin/yt-dlp',
      '/usr/bin/yt-dlp',
      'yt-dlp'
    ].filter(Boolean);

    let proc = null;
    let timeoutId = null;
    let stderr = '';
    let stdout = '';
    let title = '';
    let settled = false;
    let timedOut = false;

    const cleanup = async () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (this.activeDownloads.get(userId) === proc) {
        this.activeDownloads.delete(userId);
      }
    };

    return new Promise((resolve, reject) => {
      const fail = async (message) => {
        if (settled) return;
        settled = true;

        await cleanup();

        if (proc && proc.exitCode === null && !proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }

        await this.removeTempDir(tempDir);
        reject(new Error(message));
      };

      const startProcess = (index) => {
        if (index >= candidates.length) {
          fail(
            'yt-dlp executable not found. Checked: ' +
            candidates.join(', ') +
            '. Install yt-dlp in Dockerfile.'
          );
          return;
        }

        const command = candidates[index];

        console.log('[Downloader] Trying executable:', command);

        try {
          proc = spawn(command, args, {
            cwd: tempDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              PATH: [
                process.env.PATH || '',
                '/usr/local/bin',
                '/usr/bin',
                '/bin'
              ].join(path.delimiter)
            }
          });
        } catch (err) {
          console.error('[Downloader] Spawn error:', err.message);
          startProcess(index + 1);
          return;
        }

        let started = false;

        proc.once('spawn', () => {
          started = true;
          this.activeDownloads.set(userId, proc);

          timeoutId = setTimeout(() => {
            timedOut = true;
            try {
              proc.kill('SIGKILL');
            } catch {}
          }, DOWNLOAD_TIMEOUT_MS);
        });

        proc.stdout.on('data', (data) => {
          const text = data.toString();
          stdout += text;

          const match = text.match(/before_dl:(.+)/);
          if (match) title = match[1].trim();
        });

        proc.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;

          if (stderr.length > 15000) {
            stderr = stderr.slice(-15000);
          }

          if (typeof onProgress === 'function') {
            const percent = text.match(
              /\[download\]\s+([\d.]+)%/
            );
            const speed = text.match(/at\s+([\d.]+\s*\S+\/s)/i);
            const eta = text.match(/ETA\s+([\d:]+)/i);

            if (percent) {
              try {
                onProgress({
                  percent: Number(percent[1]),
                  speed: speed?.[1],
                  eta: eta?.[1]
                });
              } catch {}
            }
          }
        });

        proc.once('error', (err) => {
          if (settled) return;

          console.error(
            '[Downloader] Executable error:',
            command,
            err.code,
            err.message
          );

          if (!started && err.code === 'ENOENT') {
            startProcess(index + 1);
            return;
          }

          fail(`Could not start yt-dlp: ${err.code || err.message}`);
        });

        proc.once('close', async (code, signal) => {
          if (settled) return;

          await cleanup();

          if (timedOut) {
            await fail('Download timed out after 10 minutes.');
            return;
          }

          if (code !== 0) {
            const details = stderr.trim().replace(/\s+/g, ' ');
            await fail(
              details
                ? `yt-dlp error: ${details.slice(-500)}`
                : `yt-dlp exited with code ${code}, signal ${signal || 'none'}`
            );
            return;
          }

          try {
            const files = await fs.readdir(tempDir);
            let targetFile = null;
            let largestSize = 0;
            let thumbnail = null;

            for (const file of files) {
              const fullPath = path.join(tempDir, file);
              const size = await this.getFileSize(fullPath);

              if (/\.(jpg|jpeg|png|webp)$/i.test(file)) {
                thumbnail ||= fullPath;
                continue;
              }

              if (size > largestSize) {
                largestSize = size;
                targetFile = file;
              }
            }

            if (!targetFile || largestSize === 0) {
              await fail('No media file was downloaded.');
              return;
            }

            if (largestSize > MAX_FILESIZE_BYTES) {
              await fail('Downloaded file exceeds Telegram 50 MB limit.');
              return;
            }

            settled = true;

            resolve({
              filePath: path.join(tempDir, targetFile),
              tempDir,
              fileName: targetFile,
              fileSize: largestSize,
              audioOnly,
              title: title || targetFile.replace(/\.[^/.]+$/, ''),
              thumbnail
            });
          } catch (err) {
            await fail(err.message);
          }
        });
      };

      startProcess(0);
    });
  }
}

export const downloaderService = new DownloaderService();
