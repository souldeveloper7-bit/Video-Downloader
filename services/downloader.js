
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FILESIZE_BYTES = 50 * 1024 * 1024;
const MAX_FILESIZE_ARG = '50M';
const THUMBNAIL_ENABLED = true;

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
      const stats = await fs.stat(filePath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  async removeTempDir(dir) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  killUserDownload(userId) {
    const proc = this.activeDownloads.get(userId);

    if (proc) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Ignore kill errors
      }

      this.activeDownloads.delete(userId);
    }
  }

  downloadVideo(url, userId, options = {}) {
    return this.download(url, userId, {
      ...options,
      audioOnly: false,
    });
  }

  downloadAudio(url, userId, options = {}) {
    return this.download(url, userId, {
      ...options,
      audioOnly: true,
    });
  }

  download(url, userId, options = {}) {
    const { audioOnly = false, onProgress = null } = options;

    return new Promise(async (resolve, reject) => {
      const tempDir = this.createTempDir();

      try {
        await this.ensureTempDir(tempDir);
      } catch (error) {
        reject(new Error('Failed to create temporary directory.'));
        return;
      }

      let outputTemplate = path.join(tempDir, '%(title)s.%(ext)s');
      const args = [
        '--no-playlist',
        '--max-filesize', MAX_FILESIZE_ARG,
        '--restrict-filenames',
        '--no-warnings',
        '--geo-bypass',
        '--extractor-args', 'youtube:player_client=android,web,mweb',
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ];

      if (!audioOnly && THUMBNAIL_ENABLED) {
        args.push('--write-thumbnail');
      }

      if (audioOnly) {
        args.push(
          '-f',
          'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
          '-x',
          '--audio-format', 'mp3',
          '--audio-quality', '192K',
          '--postprocessor-args', 'ffmpeg:-ar 44100'
        );

        outputTemplate = path.join(tempDir, '%(title)s.mp3');
      } else {
        args.push(
          '-f',
          'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[height<=1080][ext=mp4]/best[ext=mp4]/best'
        );
      }

      args.push(
        '-o', outputTemplate,
        '--print', 'before_dl:%(title)s',
        '--',
        url
      );

      let proc;
      let timeoutId;
      let stderr = '';
      let stdout = '';
      let videoTitle = '';
      let settled = false;
      let timedOut = false;

      const cleanup = async () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        if (proc && this.activeDownloads.get(userId) === proc) {
          this.activeDownloads.delete(userId);
        }
      };

      const fail = async (error) => {
        if (settled) return;
        settled = true;
        await cleanup();
        await this.removeTempDir(tempDir);
        reject(error);
      };

      try {
        // Use the executable installed in Docker's PATH.
        const ytDlpCmd = process.env.YTDLP_PATH || 'yt-dlp';

        console.log(`[Downloader] Starting: ${ytDlpCmd}`);

        proc = spawn(ytDlpCmd, args, {
          cwd: tempDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: [
              process.env.PATH || '',
              '/usr/local/bin',
              '/usr/bin',
              '/bin',
              '/root/.local/bin',
            ].join(path.delimiter),
          },
        });

        this.activeDownloads.set(userId, proc);

        timeoutId = setTimeout(() => {
          timedOut = true;
          console.error('[Downloader] Download timed out.');

          try {
            proc.kill('SIGKILL');
          } catch {
            // Ignore kill errors
          }
        }, DOWNLOAD_TIMEOUT_MS);

        proc.stdout.on('data', (data) => {
          const text = data.toString();
          stdout += text;

          const titleMatch = stdout.match(/before_dl:([^\r\n]+)/);
          if (titleMatch) {
            videoTitle = titleMatch[1].trim();
          }
        });

        proc.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;

          if (stderr.length > 12000) {
            stderr = stderr.slice(-12000);
          }

          if (onProgress && typeof onProgress === 'function') {
            try {
              const percentMatch = text.match(
                /\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/
              );
              const speedMatch = text.match(/at\s+([0-9]+(?:\.[0-9]+)?\S+\/s)/i);
              const etaMatch = text.match(/ETA\s+([0-9:]+)/i);

              if (percentMatch) {
                const info = {
                  percent: parseFloat(percentMatch[1]),
                };

                if (speedMatch) info.speed = speedMatch[1];
                if (etaMatch) info.eta = etaMatch[1];

                onProgress(info);
              }
            } catch {
              // Ignore progress callback errors
            }
          }
        });

        proc.on('error', async (error) => {
          console.error('[Downloader] Process start error:', error.message);
          await fail(
            new Error(`Could not start yt-dlp: ${error.message}`)
          );
        });

        proc.on('close', async (code, signal) => {
          if (settled) return;

          await cleanup();

          if (timedOut) {
            await fail(new Error('Download timed out after 10 minutes.'));
            return;
          }

          if (code !== 0) {
            const details = stderr.trim().replace(/\s+/g, ' ');
            const reason = details || `exit code ${code}, signal ${signal || 'none'}`;

            console.error('[Downloader] yt-dlp failed:', reason);

            await fail(
              new Error(`yt-dlp failed: ${reason.slice(0, 350)}`)
            );
            return;
          }

          try {
            const files = await fs.readdir(tempDir);

            if (files.length === 0) {
              await fail(
                new Error('No file downloaded. The link may be invalid or unavailable.')
              );
              return;
            }

            let targetFile = null;
            let maxSize = 0;
            let thumbnailFile = null;

            for (const file of files) {
              const fullPath = path.join(tempDir, file);
              const size = await this.getFileSize(fullPath);

              if (
                size > maxSize &&
                !/\.(jpg|jpeg|png|webp|json|description)$/i.test(file)
              ) {
                maxSize = size;
                targetFile = file;
              }

              if (/\.(jpg|jpeg|png|webp)$/i.test(file) && !thumbnailFile) {
                thumbnailFile = file;
              }
            }

            if (!targetFile) {
              await fail(new Error('Downloaded media file was not found.'));
              return;
            }

            const filePath = path.join(tempDir, targetFile);
            const fileSize = await this.getFileSize(filePath);

            if (fileSize > MAX_FILESIZE_BYTES) {
              await fail(
                new Error('Downloaded file exceeds Telegram 50 MB upload limit.')
              );
              return;
            }

            if (fileSize === 0) {
              await fail(new Error('Downloaded file is empty.'));
              return;
            }

            settled = true;

            resolve({
              filePath,
              tempDir,
              fileName: targetFile,
              fileSize,
              audioOnly,
              title: videoTitle || targetFile.replace(/\.[^/.]+$/, ''),
              thumbnail: thumbnailFile
                ? path.join(tempDir, thumbnailFile)
                : null,
            });
          } catch (error) {
            await fail(error);
          }
        });
      } catch (error) {
        console.error('[Downloader] Unexpected error:', error);
        await fail(error);
      }
    });
  }
}

export const downloaderService = new DownloaderService();
