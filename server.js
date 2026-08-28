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
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({
  dest: UP,
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 20
  }
});

/* =========================
   RUN COMMAND
========================= */

function run(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
            stdout.trim() ||
            `Process exited with code ${code}`
          )
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/* =========================
   DETECT PLATFORM
========================= */

function detectPlatform(url) {
  const value = url.toLowerCase();

  if (
    value.includes('youtube.com') ||
    value.includes('youtu.be')
  ) {
    return 'youtube';
  }

  if (
    value.includes('tiktok.com') ||
    value.includes('vt.tiktok.com')
  ) {
    return 'tiktok';
  }

  if (
    value.includes('instagram.com')
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

/* =========================
   COOKIES
========================= */

function createCookieFile(variableName, prefix) {
  const encoded = process.env[variableName];

  if (!encoded) {
    return null;
  }

  let tempDir = null;

  try {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), prefix)
    );

    const file = path.join(
      tempDir,
      'cookies.txt'
    );

    const data = Buffer
      .from(encoded.trim(), 'base64')
      .toString('utf8');

    if (!data.includes('# Netscape HTTP Cookie File')) {
      throw new Error(
        `${variableName} bukan cookies.txt format Netscape`
      );
    }

    fs.writeFileSync(
      file,
      data,
      {
        encoding: 'utf8',
        mode: 0o600
      }
    );

    return {
      file,
      dir: tempDir
    };

  } catch (error) {

    if (tempDir) {
      try {
        fs.rmSync(tempDir, {
          recursive: true,
          force: true
        });
      } catch {}
    }

    throw error;
  }
}

function removeCookieFile(info) {
  if (!info) return;

  try {
    fs.rmSync(info.dir, {
      recursive: true,
      force: true
    });
  } catch {}
}

/* =========================
   HEALTH
========================= */

app.get('/api/health', (req, res) => {

  res.json({
    ok: true,
    status: 'online',

    service: 'Palend Downloader',

    cookies: {
      youtube: Boolean(
        process.env.YOUTUBE_COOKIES_B64
      ),

      instagram: Boolean(
        process.env.INSTAGRAM_COOKIES_B64
      ),

      tiktok: Boolean(
        process.env.TIKTOK_COOKIES_B64
      )
    },

    time: new Date().toISOString()
  });
});

/* =========================
   DOWNLOAD
========================= */

app.post('/api/download', async (req, res) => {

  const {
    url,
    format = 'mp4'
  } = req.body || {};

  if (
    !url ||
    !/^https?:\/\//i.test(url)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'URL tidak valid.'
    });
  }

  const platform = detectPlatform(url);

  if (platform === 'unknown') {
    return res.status(400).json({
      ok: false,
      error:
        'Platform belum didukung.'
    });
  }

  console.log(
    'DOWNLOAD PLATFORM:',
    platform
  );

  console.log(
    'DOWNLOAD URL:',
    url
  );

  const id =
    crypto.randomBytes(8).toString('hex');

  const template = path.join(
    OUT,
    `${id}.%(ext)s`
  );

  let cookieInfo = null;

  try {

    /* =====================
       COOKIES PER PLATFORM
    ===================== */

    if (platform === 'youtube') {

      cookieInfo = createCookieFile(
        'YOUTUBE_COOKIES_B64',
        'palend-youtube-'
      );

    } else if (platform === 'instagram') {

      cookieInfo = createCookieFile(
        'INSTAGRAM_COOKIES_B64',
        'palend-instagram-'
      );

    } else if (platform === 'tiktok') {

      cookieInfo = createCookieFile(
        'TIKTOK_COOKIES_B64',
        'palend-tiktok-'
      );
    }

    /* =====================
       BASE ARGUMENTS
    ===================== */

    const args = [
      '--no-playlist',
      '--restrict-filenames',
      '--newline',
      '--no-warnings',

      '--socket-timeout',
      '30',

      '--retries',
      '3',

      '--fragment-retries',
      '3',

      '-o',
      template
    ];

    /* =====================
       COOKIES
    ===================== */

    if (cookieInfo) {

      args.push(
        '--cookies',
        cookieInfo.file
      );

    }

    /* =====================
       TIKTOK
    ===================== */

    if (platform === 'tiktok') {

      /*
       * Browser impersonation.
       *
       * Membantu situs yang melakukan
       * TLS/browser fingerprint checking.
       */

      args.push(
        '--impersonate',
        'chrome'
      );
    }

    /* =====================
       INSTAGRAM
    ===================== */

    if (platform === 'instagram') {

      args.push(
        '--impersonate',
        'chrome'
      );
    }

    /* =====================
       YOUTUBE
    ===================== */

    if (platform === 'youtube') {

      args.push(
        '--extractor-args',
        'youtube:player_client=android,web'
      );
    }

    /* =====================
       FORMAT
    ===================== */

    if (format === 'mp3') {

      args.push(
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0'
      );

    } else {

      args.push(
        '-f',
        'bv*+ba/b',
        '--merge-output-format',
        'mp4'
      );
    }

    args.push(url);

    console.log(
      'YT-DLP ARGS:',
      args.filter(
        x => !String(x).includes('cookies.txt')
      )
    );

    /* =====================
       RUN YT-DLP
    ===================== */

    await run(
      process.env.YTDLP_BIN || 'yt-dlp',
      args
    );

    /* =====================
       FIND OUTPUT
    ===================== */

    const files =
      fs.readdirSync(OUT);

    const filename =
      files.find(
        file =>
          file.startsWith(`${id}.`)
      );

    if (!filename) {

      throw new Error(
        'File hasil download tidak ditemukan.'
      );
    }

    console.log(
      'DOWNLOAD SUCCESS:',
      filename
    );

    return res.json({

      ok: true,

      platform,

      filename,

      download:
        '/api/file/' +
        encodeURIComponent(filename)
    });

  } catch (error) {

    const detail =
      String(error.message || '');

    console.error(
      'DOWNLOAD ERROR:',
      detail
    );

    let message =
      'Gagal memproses video.';

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
        )
      )
    ) {

      message =
        'YouTube meminta autentikasi. Periksa cookies YouTube di Railway.';

    } else if (
      platform === 'tiktok'
    ) {

      message =
        'TikTok menolak permintaan atau extractor yt-dlp sedang mengalami perubahan. Coba URL TikTok lain.';

    } else if (
      platform === 'instagram'
    ) {

      message =
        'Instagram menolak permintaan. Jika konten membutuhkan login, tambahkan cookies Instagram.';

    } else {

      message =
        'URL tidak dapat diproses oleh yt-dlp.';

    }

    return res.status(500).json({

      ok: false,

      platform,

      error: message,

      detail:
        detail.slice(0, 1000)
    });

  } finally {

    removeCookieFile(cookieInfo);
  }
});

/* =========================
   DOWNLOAD FILE
========================= */

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
          'File tidak ditemukan'
        );
    }

    res.download(
      file,
      filename
    );
  }
);

/* =========================
   MERGE VIDEO
========================= */

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
      crypto.randomBytes(8)
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
          .map(file => {

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

      for (
        const file of
        req.files || []
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

/* =========================
   FRONTEND
========================= */

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

/* =========================
   START
========================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `Palend Downloader listening on ${PORT}`
    );

  }
);
