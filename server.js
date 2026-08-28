const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const UP = path.join(ROOT, 'uploads');
const OUT = path.join(ROOT, 'outputs');
const PUBLIC = path.join(ROOT, 'public');

[UP, OUT].forEach((dir) => {
  fs.mkdirSync(dir, {
    recursive: true
  });
});

app.use(express.json({
  limit: '2mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '2mb'
}));

app.use(express.static(PUBLIC));

/* =========================================================
   MULTER
========================================================= */

const upload = multer({
  dest: UP,
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 20
  }
});

/* =========================================================
   RUN COMMAND
========================================================= */

function run(command, args = []) {
  return new Promise((resolve, reject) => {
    console.log('RUN:', command, args.join(' '));

    const child = spawn(command, args, {
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const message =
          stderr.trim() ||
          stdout.trim() ||
          `Process exited with code ${code}`;

        reject(new Error(message));
        return;
      }

      resolve({
        stdout,
        stderr
      });
    });
  });
}

/* =========================================================
   YOUTUBE COOKIES
========================================================= */

function createYoutubeCookiesFile() {
  const encoded = process.env.YOUTUBE_COOKIES_B64;

  if (!encoded) {
    console.log('YouTube cookies: tidak dikonfigurasi');
    return null;
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'palend-youtube-')
  );

  const cookieFile = path.join(
    tempDir,
    'cookies.txt'
  );

  try {
    const cookieData = Buffer
      .from(encoded.trim(), 'base64')
      .toString('utf8');

    if (!cookieData.trim()) {
      throw new Error(
        'YOUTUBE_COOKIES_B64 kosong.'
      );
    }

    /*
     * Cookies Netscape biasanya memiliki header ini.
     * Kita tidak memaksa terlalu ketat karena beberapa
     * export cookies memiliki komentar/header berbeda.
     */
    const valid =
      cookieData.includes(
        '# Netscape HTTP Cookie File'
      ) ||
      cookieData.includes(
        '# HTTP Cookie File'
      ) ||
      cookieData.split('\n').some((line) => {
        const parts = line.split('\t');
        return parts.length >= 7;
      });

    if (!valid) {
      throw new Error(
        'Format cookies tidak valid. Gunakan cookies.txt format Netscape.'
      );
    }

    fs.writeFileSync(
      cookieFile,
      cookieData,
      {
        encoding: 'utf8',
        mode: 0o600
      }
    );

    console.log(
      'YouTube cookies: aktif'
    );

    return {
      file: cookieFile,
      dir: tempDir
    };

  } catch (error) {
    try {
      fs.rmSync(tempDir, {
        recursive: true,
        force: true
      });
    } catch {}

    throw error;
  }
}

function removeYoutubeCookies(cookieInfo) {
  if (!cookieInfo) {
    return;
  }

  try {
    fs.rmSync(cookieInfo.dir, {
      recursive: true,
      force: true
    });
  } catch {}
}

/* =========================================================
   DETECT PLATFORM
========================================================= */

function detectPlatform(url) {
  const value = String(url || '').toLowerCase();

  if (
    value.includes('youtube.com') ||
    value.includes('youtu.be') ||
    value.includes('youtube-nocookie.com')
  ) {
    return 'youtube';
  }

  if (
    value.includes('tiktok.com') ||
    value.includes('vt.tiktok.com') ||
    value.includes('vm.tiktok.com')
  ) {
    return 'tiktok';
  }

  if (
    value.includes('instagram.com') ||
    value.includes('instagr.am')
  ) {
    return 'instagram';
  }

  if (
    value.includes('facebook.com') ||
    value.includes('fb.watch')
  ) {
    return 'facebook';
  }

  if (
    value.includes('twitter.com') ||
    value.includes('x.com')
  ) {
    return 'twitter';
  }

  return 'other';
}

/* =========================================================
   URL VALIDATION
========================================================= */

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:'
    );
  } catch {
    return false;
  }
}

/* =========================================================
   DOWNLOAD ARGUMENTS
========================================================= */

function buildDownloadArgs({
  url,
  format,
  outputTemplate,
  cookieInfo,
  platform
}) {
  const args = [
    '--no-playlist',
    '--restrict-filenames',
    '--no-warnings',
    '--newline',

    /*
     * Jangan berhenti hanya karena salah satu format
     * tidak tersedia.
     */
    '--ignore-errors',

    /*
     * User-Agent browser umum.
     */
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',

    /*
     * Output.
     */
    '-o',
    outputTemplate
  ];

  /*
   * YouTube cookies.
   */
  if (
    platform === 'youtube' &&
    cookieInfo
  ) {
    args.push(
      '--cookies',
      cookieInfo.file
    );
  }

  /*
   * MP3.
   */
  if (format === 'mp3') {
    args.push(
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0'
    );

    args.push(url);

    return args;
  }

  /*
   * MP4.
   *
   * Prioritas:
   * 1. H264 + M4A
   * 2. MP4 biasa
   * 3. Format terbaik yang tersedia
   *
   * H264 diprioritaskan agar lebih banyak HP dapat
   * memutar hasil download.
   */
  args.push(
    '-f',
    'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best',

    '--merge-output-format',
    'mp4',

    /*
     * Metadata/container dibuat lebih ramah pemutar
     * video mobile.
     */
    '--postprocessor-args',
    'Merger:-movflags +faststart'
  );

  args.push(url);

  return args;
}

/* =========================================================
   HEALTH
========================================================= */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'online',
    service: 'Palend Downloader',
    youtubeCookiesConfigured:
      Boolean(
        process.env.YOUTUBE_COOKIES_B64
      ),
    ytdlp:
      process.env.YTDLP_BIN ||
      'yt-dlp',
    ffmpeg:
      process.env.FFMPEG_BIN ||
      'ffmpeg',
    time: new Date().toISOString()
  });
});

/* =========================================================
   VERSION CHECK
========================================================= */

app.get('/api/version', async (req, res) => {
  try {
    const result = await run(
      process.env.YTDLP_BIN || 'yt-dlp',
      ['--version']
    );

    let ffmpegVersion = '';

    try {
      const ffmpeg = await run(
        process.env.FFMPEG_BIN || 'ffmpeg',
        ['-version']
      );

      ffmpegVersion =
        ffmpeg.stdout
          .split('\n')[0]
          .trim();
    } catch {}

    res.json({
      ok: true,
      ytDlp: result.stdout.trim(),
      ffmpeg: ffmpegVersion
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message)
    });
  }
});

/* =========================================================
   DOWNLOAD
========================================================= */

app.post(
  '/api/download',
  async (req, res) => {

    const {
      url,
      format = 'mp4'
    } = req.body || {};

    if (!url) {
      return res.status(400).json({
        ok: false,
        error: 'Link video belum diisi.'
      });
    }

    if (!isValidHttpUrl(url)) {
      return res.status(400).json({
        ok: false,
        error: 'Link video tidak valid.'
      });
    }

    const selectedFormat =
      format === 'mp3'
        ? 'mp3'
        : 'mp4';

    const platform =
      detectPlatform(url);

    console.log(
      'DOWNLOAD PLATFORM:',
      platform
    );

    console.log(
      'DOWNLOAD URL:',
      url
    );

    const id =
      crypto
        .randomBytes(8)
        .toString('hex');

    const outputTemplate =
      path.join(
        OUT,
        `${id}.%(ext)s`
      );

    let cookieInfo = null;

    try {

      /*
       * Cookies hanya untuk YouTube.
       */
      if (platform === 'youtube') {
        cookieInfo =
          createYoutubeCookiesFile();
      }

      const args =
        buildDownloadArgs({
          url,
          format: selectedFormat,
          outputTemplate,
          cookieInfo,
          platform
        });

      await run(
        process.env.YTDLP_BIN ||
          'yt-dlp',
        args
      );

      /*
       * Cari file hasil.
       */
      const files =
        fs.readdirSync(OUT);

      const candidates =
        files.filter((file) =>
          file.startsWith(`${id}.`)
        );

      /*
       * Jangan mengambil file .part
       * atau file sementara.
       */
      const finished =
        candidates.find((file) =>
          !file.endsWith('.part') &&
          !file.endsWith('.ytdl')
        );

      if (!finished) {
        throw new Error(
          'File hasil download tidak ditemukan.'
        );
      }

      const resultFile =
        path.join(
          OUT,
          finished
        );

      if (!fs.existsSync(resultFile)) {
        throw new Error(
          'File hasil tidak tersedia.'
        );
      }

      const stats =
        fs.statSync(resultFile);

      if (stats.size <= 0) {
        throw new Error(
          'File hasil kosong.'
        );
      }

      console.log(
        'DOWNLOAD SUCCESS:',
        finished,
        stats.size,
        'bytes'
      );

      return res.json({
        ok: true,
        platform,
        format: selectedFormat,
        filename: finished,
        size: stats.size,
        download:
          '/api/file/' +
          encodeURIComponent(
            finished
          )
      });

    } catch (error) {

      console.error(
        'DOWNLOAD ERROR:',
        error.message
      );

      const detail =
        String(
          error.message || ''
        );

      let message =
        'Gagal memproses video.';

      /*
       * YouTube authentication.
       */
      if (
        platform === 'youtube' &&
        (
          detail.includes(
            'Sign in to confirm'
          ) ||
          detail.includes(
            'not a bot'
          ) ||
          detail.includes(
            'cookies'
          ) ||
          detail.includes(
            'LOGIN_REQUIRED'
          )
        )
      ) {
        message =
          'YouTube meminta verifikasi. Pastikan cookies YouTube masih aktif.';
      }

      /*
       * Format.
       */
      else if (
        detail.includes(
          'Requested format is not available'
        )
      ) {
        message =
          'Format video tersebut tidak tersedia. Coba pilih Video MP4 biasa.';
      }

      /*
       * TikTok.
       */
      else if (
        platform === 'tiktok'
      ) {
        message =
          'Video TikTok tidak dapat diproses saat ini. Pastikan link TikTok masih aktif.';
      }

      /*
       * Instagram.
       */
      else if (
        platform === 'instagram'
      ) {
        message =
          'Video Instagram tidak dapat diproses. Pastikan video bersifat publik.';
      }

      /*
       * FFmpeg.
       */
      else if (
        detail.toLowerCase()
          .includes('ffmpeg')
      ) {
        message =
          'FFmpeg tidak tersedia atau gagal memproses video.';
      }

      return res.status(500).json({
        ok: false,
        error: message,
        platform,
        detail:
          detail.slice(0, 1200)
      });

    } finally {

      removeYoutubeCookies(
        cookieInfo
      );
    }
  }
);

/* =========================================================
   DOWNLOAD FILE
========================================================= */

app.get(
  '/api/file/:name',
  (req, res) => {

    const filename =
      path.basename(
        req.params.name
      );

    const file =
      path.join(
        OUT,
        filename
      );

    if (!fs.existsSync(file)) {
      return res.status(404).send(
        'File tidak ditemukan atau sudah dihapus.'
      );
    }

    const stats =
      fs.statSync(file);

    if (stats.size <= 0) {
      return res.status(404).send(
        'File kosong.'
      );
    }

    res.download(
      file,
      filename,
      (error) => {

        if (error) {
          console.error(
            'FILE DOWNLOAD ERROR:',
            error.message
          );
        }

        /*
         * Hapus file setelah selesai dikirim.
         */
        if (
          !res.headersSent
        ) {
          return;
        }

        setTimeout(() => {
          try {
            if (
              fs.existsSync(file)
            ) {
              fs.unlinkSync(file);

              console.log(
                'FILE DELETED:',
                filename
              );
            }
          } catch {}
        }, 30000);
      }
    );
  }
);

/* =========================================================
   MERGE VIDEO
========================================================= */

app.post(
  '/api/merge',
  upload.array(
    'videos',
    20
  ),
  async (req, res) => {

    if (
      !req.files ||
      req.files.length < 2
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'Pilih minimal 2 video.'
      });
    }

    const id =
      crypto
        .randomBytes(8)
        .toString('hex');

    const listFile =
      path.join(
        UP,
        `${id}.txt`
      );

    const outputFile =
      path.join(
        OUT,
        `${id}-palend.mp4`
      );

    try {

      const listContent =
        req.files
          .map((file) => {

            const safePath =
              file.path.replace(
                /'/g,
                "'\\''"
              );

            return `file '${safePath}'`;
          })
          .join('\n');

      fs.writeFileSync(
        listFile,
        listContent,
        'utf8'
      );

      await run(
        process.env.FFMPEG_BIN ||
          'ffmpeg',
        [
          '-y',

          '-f',
          'concat',

          '-safe',
          '0',

          '-i',
          listFile,

          '-c',
          'copy',

          '-movflags',
          '+faststart',

          outputFile
        ]
      );

      if (
        !fs.existsSync(
          outputFile
        )
      ) {
        throw new Error(
          'File hasil penggabungan tidak ditemukan.'
        );
      }

      const stats =
        fs.statSync(
          outputFile
        );

      if (stats.size <= 0) {
        throw new Error(
          'File hasil penggabungan kosong.'
        );
      }

      return res.json({
        ok: true,
        filename:
          path.basename(
            outputFile
          ),
        size: stats.size,
        download:
          '/api/file/' +
          encodeURIComponent(
            path.basename(
              outputFile
            )
          )
      });

    } catch (error) {

      console.error(
        'MERGE ERROR:',
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          'Penggabungan gagal. Pastikan format video kompatibel.',
        detail:
          String(
            error.message
          ).slice(0, 1000)
      });

    } finally {

      /*
       * Hapus file upload.
       */
      for (
        const file
        of req.files || []
      ) {
        try {
          fs.unlinkSync(
            file.path
          );
        } catch {}
      }

      /*
       * Hapus daftar concat.
       */
      try {
        fs.unlinkSync(
          listFile
        );
      } catch {}
    }
  }
);

/* =========================================================
   CLEAN TEMPORARY FILES
========================================================= */

function cleanupOldFiles() {
  const now =
    Date.now();

  const maxAge =
    30 * 60 * 1000;

  for (
    const directory
    of [UP, OUT]
  ) {

    try {

      const files =
        fs.readdirSync(
          directory
        );

      for (
        const filename
        of files
      ) {

        const file =
          path.join(
            directory,
            filename
          );

        try {

          const stats =
            fs.statSync(file);

          if (
            now -
              stats.mtimeMs >
            maxAge
          ) {
            fs.unlinkSync(file);

            console.log(
              'CLEANUP:',
              file
            );
          }

        } catch {}
      }

    } catch {}
  }
}

/*
 * Bersihkan file lama setiap 10 menit.
 */
setInterval(
  cleanupOldFiles,
  10 * 60 * 1000
);

/* =========================================================
   WEBSITE FALLBACK
========================================================= */

/*
 * PENTING:
 *
 * Jangan menggunakan:
 *
 * app.get('*', ...)
 *
 * karena Express/router versi baru dapat menghasilkan:
 *
 * Missing parameter name at index 1: *
 *
 * Gunakan middleware fallback seperti ini.
 */

app.use(
  (req, res) => {

    /*
     * Jangan mengganggu API yang tidak ditemukan.
     */
    if (
      req.path.startsWith('/api/')
    ) {
      return res.status(404).json({
        ok: false,
        error: 'API endpoint tidak ditemukan.'
      });
    }

    res.sendFile(
      path.join(
        PUBLIC,
        'index.html'
      )
    );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      'EXPRESS ERROR:',
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      ok: false,
      error:
        'Terjadi kesalahan pada server.'
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      '================================='
    );

    console.log(
      'PALEND DOWNLOADER'
    );

    console.log(
      'Server aktif di port:',
      PORT
    );

    console.log(
      'YouTube cookies:',
      process.env.YOUTUBE_COOKIES_B64
        ? 'AKTIF'
        : 'TIDAK ADA'
    );

    console.log(
      'yt-dlp:',
      process.env.YTDLP_BIN ||
        'yt-dlp'
    );

    console.log(
      'FFmpeg:',
      process.env.FFMPEG_BIN ||
        'ffmpeg'
    );

    console.log(
      '================================='
    );
  }
);
