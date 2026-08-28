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

fs.mkdirSync(UP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(ROOT, 'public')));

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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: {
        ...process.env
      }
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
        reject(
          new Error(
            stderr.trim() ||
            stdout.trim() ||
            `Process exited with code ${code}`
          )
        );
      } else {
        resolve({
          stdout,
          stderr
        });
      }
    });
  });
}

/* =========================================================
   URL DETECTION
========================================================= */

function getPlatform(url) {
  const value = String(url).toLowerCase();

  if (
    value.includes('youtube.com') ||
    value.includes('youtu.be') ||
    value.includes('youtube-nocookie.com')
  ) {
    return 'youtube';
  }

  if (
    value.includes('tiktok.com') ||
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

  return 'unknown';
}

/* =========================================================
   COOKIE FILE
========================================================= */

/*
  Railway Variable:

  YOUTUBE_COOKIES_B64

  Nilai:
  Base64 dari cookies.txt format Netscape.
*/

function createCookiesFile() {
  const encoded = process.env.YOUTUBE_COOKIES_B64;

  if (!encoded) {
    return null;
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'palend-cookies-')
  );

  const cookieFile = path.join(
    tempDir,
    'cookies.txt'
  );

  try {
    const cookieData = Buffer
      .from(encoded, 'base64')
      .toString('utf8');

    if (!cookieData.trim()) {
      throw new Error(
        'YOUTUBE_COOKIES_B64 kosong.'
      );
    }

    /*
      yt-dlp membutuhkan format Netscape.

      Kita cek apakah file memiliki header Netscape
      atau minimal memiliki baris cookie yang valid.
    */

    const lines = cookieData
      .split(/\r?\n/)
      .map(line => line.trimEnd());

    const hasNetscapeHeader = lines.some(
      line =>
        line.includes('# Netscape HTTP Cookie File')
    );

    const validCookieLines = lines.filter(line => {
      if (!line.trim()) return false;
      if (line.startsWith('#')) return false;

      const parts = line.split('\t');

      return parts.length >= 7;
    });

    if (
      !hasNetscapeHeader &&
      validCookieLines.length === 0
    ) {
      throw new Error(
        'Cookie tidak dalam format Netscape cookies.txt.'
      );
    }

    /*
      Buang baris cookie yang rusak.

      Ini penting karena beberapa exporter browser
      kadang memasukkan baris seperti:

      .pubma

      yang menyebabkan yt-dlp:
      "skipping cookie file entry due to invalid length"
    */

    const cleaned = lines.filter(line => {
      if (!line.trim()) return true;

      if (line.startsWith('#')) {
        return true;
      }

      const parts = line.split('\t');

      return parts.length >= 7;
    });

    fs.writeFileSync(
      cookieFile,
      cleaned.join('\n'),
      {
        encoding: 'utf8',
        mode: 0o600
      }
    );

    return {
      file: cookieFile,
      dir: tempDir
    };

  } catch (error) {

    try {
      fs.rmSync(
        tempDir,
        {
          recursive: true,
          force: true
        }
      );
    } catch {}

    throw error;
  }
}

/* =========================================================
   REMOVE COOKIE FILE
========================================================= */

function removeCookiesFile(cookieInfo) {
  if (!cookieInfo) return;

  try {
    fs.rmSync(
      cookieInfo.dir,
      {
        recursive: true,
        force: true
      }
    );
  } catch {}
}

/* =========================================================
   CLEAN OLD FILES
========================================================= */

function cleanOldFiles() {
  const now = Date.now();
  const MAX_AGE = 30 * 60 * 1000;

  for (const directory of [UP, OUT]) {
    try {
      const files = fs.readdirSync(directory);

      for (const file of files) {
        const full = path.join(
          directory,
          file
        );

        try {
          const stat = fs.statSync(full);

          if (
            now - stat.mtimeMs >
            MAX_AGE
          ) {
            fs.rmSync(
              full,
              {
                recursive: true,
                force: true
              }
            );
          }
        } catch {}
      }
    } catch {}
  }
}

setInterval(
  cleanOldFiles,
  10 * 60 * 1000
);

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
    supportedPlatforms: [
      'YouTube',
      'TikTok',
      'Instagram',
      'Facebook',
      'X/Twitter'
    ],
    time: new Date().toISOString()
  });
});

/* =========================================================
   INFO
========================================================= */

app.get('/api/info', async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({
      ok: false,
      error: 'URL wajib diisi.'
    });
  }

  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({
      ok: false,
      error: 'URL tidak valid.'
    });
  }

  const platform = getPlatform(url);

  if (platform === 'unknown') {
    return res.status(400).json({
      ok: false,
      error:
        'Platform belum didukung.'
    });
  }

  let cookieInfo = null;

  try {
    cookieInfo = createCookiesFile();

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--skip-download',
      '--dump-single-json',
      '--restrict-filenames'
    ];

    /*
      Cookies terutama diperlukan untuk YouTube.
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

    args.push(url);

    const result = await run(
      process.env.YTDLP_BIN || 'yt-dlp',
      args
    );

    const info = JSON.parse(
      result.stdout
    );

    return res.json({
      ok: true,
      platform,
      id: info.id || null,
      title: info.title || 'Video',
      thumbnail:
        info.thumbnail || null,
      duration:
        info.duration || null,
      uploader:
        info.uploader ||
        info.channel ||
        null
    });

  } catch (error) {

    console.error(
      'INFO ERROR:',
      error.message
    );

    return res.status(500).json({
      ok: false,
      platform,
      error:
        'Gagal membaca informasi video.',
      detail:
        String(error.message)
          .slice(0, 1000)
    });

  } finally {
    removeCookiesFile(cookieInfo);
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
        error: 'URL wajib diisi.'
      });
    }

    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({
        ok: false,
        error: 'URL tidak valid.'
      });
    }

    const platform =
      getPlatform(url);

    if (platform === 'unknown') {
      return res.status(400).json({
        ok: false,
        error:
          'Platform tidak didukung.'
      });
    }

    const id =
      crypto
        .randomBytes(8)
        .toString('hex');

    const template = path.join(
      OUT,
      `${id}.%(ext)s`
    );

    let cookieInfo = null;

    try {

      cookieInfo =
        createCookiesFile();

      const args = [
        '--no-playlist',
        '--restrict-filenames',
        '--no-warnings',
        '--newline',
        '--no-part',
        '-o',
        template
      ];

      /*
        Hanya gunakan cookies untuk YouTube.
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

      /* ================================
         MP3
      ================================= */

      if (
        String(format).toLowerCase() ===
        'mp3'
      ) {

        args.push(
          '-x',
          '--audio-format',
          'mp3',
          '--audio-quality',
          '0'
        );

      }

      /* ================================
         MP4
      ================================= */

      else {

        args.push(
          '-f',
          'bv*+ba/b',
          '--merge-output-format',
          'mp4'
        );
      }

      args.push(url);

      console.log(
        `DOWNLOAD ${platform}: ${url}`
      );

      await run(
        process.env.YTDLP_BIN ||
          'yt-dlp',
        args
      );

      /*
        Cari file hasil.
      */

      const files =
        fs.readdirSync(OUT);

      const filename =
        files.find(
          file =>
            file.startsWith(
              `${id}.`
            )
        );

      if (!filename) {
        throw new Error(
          'File hasil download tidak ditemukan.'
        );
      }

      console.log(
        `DOWNLOAD SUCCESS: ${filename}`
      );

      return res.json({
        ok: true,
        platform,
        filename,
        download:
          '/api/file/' +
          encodeURIComponent(
            filename
          )
      });

    } catch (error) {

      const detail =
        String(
          error.message || ''
        );

      console.error(
        'DOWNLOAD ERROR:',
        detail
      );

      let message =
        'Gagal memproses video.';

      if (
        detail.includes(
          'Sign in to confirm'
        ) ||
        detail.includes(
          'not a bot'
        ) ||
        detail.includes(
          'cookies'
        )
      ) {

        message =
          'YouTube meminta autentikasi. Pastikan cookies YouTube di Railway masih valid.';

      } else if (
        detail.includes(
          'Unsupported URL'
        )
      ) {

        message =
          'URL tidak didukung oleh yt-dlp.';

      } else if (
        detail.includes(
          'ffmpeg'
        )
      ) {

        message =
          'FFmpeg tidak tersedia atau gagal digunakan.';

      } else if (
        platform === 'instagram'
      ) {

        message =
          'Instagram menolak permintaan atau video tidak dapat diakses. Coba URL posting/Reel yang publik.';

      } else if (
        platform === 'tiktok'
      ) {

        message =
          'TikTok menolak permintaan atau URL tidak dapat diproses. Coba URL video TikTok yang publik.';

      }

      return res.status(500).json({
        ok: false,
        platform,
        error: message,
        detail:
          detail.slice(0, 1000)
      });

    } finally {

      removeCookiesFile(
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

    if (
      !fs.existsSync(file)
    ) {
      return res
        .status(404)
        .send(
          'File tidak ditemukan.'
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

      /*
        Buat daftar video untuk FFmpeg.
      */

      const listContent =
        req.files
          .map(
            file => {

              const safePath =
                file.path
                  .replace(
                    /'/g,
                    "'\\''"
                  );

              return `file '${safePath}'`;
            }
          )
          .join('\n');

      fs.writeFileSync(
        listFile,
        listContent
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
          outputFile
        ]
      );

      return res.json({
        ok: true,
        filename:
          path.basename(
            outputFile
          ),
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
          'Penggabungan video gagal.',
        detail:
          String(
            error.message
          ).slice(0, 1000)
      });

    } finally {

      /*
        Hapus file upload sementara.
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

      try {
        fs.unlinkSync(
          listFile
        );
      } catch {}
    }
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  '*',
  (req, res) => {

    res.sendFile(
      path.join(
        ROOT,
        'public',
        'index.html'
      )
    );
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
      `Palend Downloader listening on ${PORT}`
    );

    console.log(
      'Supported: YouTube, TikTok, Instagram, Facebook, X/Twitter'
    );

    console.log(
      'YouTube cookies:',
      process.env.YOUTUBE_COOKIES_B64
        ? 'CONFIGURED'
        : 'NOT CONFIGURED'
    );
  }
);
