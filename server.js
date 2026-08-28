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

[UP, OUT].forEach((dir) => {
  fs.mkdirSync(dir, { recursive: true });
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({
  dest: UP,
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 20
  }
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args);

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('error', reject);

    process.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() || stdout.trim() || `Process exited with code ${code}`
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

/*
 * Membuat file cookies sementara dari Railway Variable.
 *
 * Railway Variable:
 * YOUTUBE_COOKIES_B64
 *
 * Isinya adalah cookies.txt dalam bentuk Base64.
 */
function createYoutubeCookiesFile() {
  const encoded = process.env.YOUTUBE_COOKIES_B64;

  if (!encoded) {
    return null;
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'palend-youtube-')
  );

  const cookieFile = path.join(tempDir, 'cookies.txt');

  try {
    const cookieData = Buffer.from(encoded, 'base64').toString('utf8');

    if (!cookieData.includes('# Netscape HTTP Cookie File')) {
      fs.rmSync(tempDir, {
        recursive: true,
        force: true
      });

      throw new Error(
        'Format cookies tidak valid. Gunakan cookies.txt format Netscape.'
      );
    }

    fs.writeFileSync(cookieFile, cookieData, {
      encoding: 'utf8',
      mode: 0o600
    });

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
  if (!cookieInfo) return;

  try {
    fs.rmSync(cookieInfo.dir, {
      recursive: true,
      force: true
    });
  } catch {}
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'online',
    service: 'Palend Downloader',
    youtubeCookiesConfigured: Boolean(
      process.env.YOUTUBE_COOKIES_B64
    ),
    time: new Date().toISOString()
  });
});

app.post('/api/download', async (req, res) => {
  const {
    url,
    format = 'mp4'
  } = req.body || {};

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({
      ok: false,
      error: 'URL tidak valid.'
    });
  }

  const id = crypto.randomBytes(8).toString('hex');

  const template = path.join(
    OUT,
    `${id}.%(ext)s`
  );

  let cookieInfo = null;

  try {
    cookieInfo = createYoutubeCookiesFile();

    const args = [
      '--no-playlist',
      '--restrict-filenames',
      '--no-warnings',
      '--newline',
      '-o',
      template
    ];

    /*
     * Jika cookies tersedia, gunakan cookies.
     */
    if (cookieInfo) {
      args.push(
        '--cookies',
        cookieInfo.file
      );
    }

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

    await run(
      process.env.YTDLP_BIN || 'yt-dlp',
      args
    );

    const files = fs.readdirSync(OUT);

    const filename = files.find(
      (file) => file.startsWith(`${id}.`)
    );

    if (!filename) {
      throw new Error(
        'File hasil download tidak ditemukan.'
      );
    }

    return res.json({
      ok: true,
      filename,
      download:
        '/api/file/' +
        encodeURIComponent(filename)
    });

  } catch (error) {
    console.error(
      'DOWNLOAD ERROR:',
      error.message
    );

    let message =
      'Gagal memproses video. ';

    const detail = String(error.message || '');

    if (
      detail.includes('Sign in to confirm') ||
      detail.includes('not a bot') ||
      detail.includes('cookies')
    ) {
      message +=
        'YouTube meminta autentikasi. Pastikan cookies YouTube di Railway sudah benar dan masih aktif.';
    } else {
      message +=
        'Pastikan URL didukung dan yt-dlp serta FFmpeg tersedia.';
    }

    return res.status(500).json({
      ok: false,
      error: message,
      detail: detail.slice(0, 700)
    });

  } finally {
    removeYoutubeCookies(cookieInfo);
  }
});

app.get('/api/file/:name', (req, res) => {
  const filename = path.basename(
    req.params.name
  );

  const file = path.join(
    OUT,
    filename
  );

  if (!fs.existsSync(file)) {
    return res.status(404).send(
      'File tidak ditemukan'
    );
  }

  res.download(
    file,
    filename
  );
});

app.post(
  '/api/merge',
  upload.array('videos', 20),
  async (req, res) => {

    if (
      !req.files ||
      req.files.length < 2
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Pilih minimal 2 video.'
      });
    }

    const id =
      crypto.randomBytes(8).toString('hex');

    const listFile = path.join(
      UP,
      `${id}.txt`
    );

    const outputFile = path.join(
      OUT,
      `${id}-palend.mp4`
    );

    try {
      const listContent = req.files
        .map((file) => {
          const safePath =
            file.path.replace(/'/g, "'\\''");

          return `file '${safePath}'`;
        })
        .join('\n');

      fs.writeFileSync(
        listFile,
        listContent
      );

      await run(
        process.env.FFMPEG_BIN || 'ffmpeg',
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
          path.basename(outputFile),
        download:
          '/api/file/' +
          encodeURIComponent(
            path.basename(outputFile)
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
          'Penggabungan gagal. Coba video dengan codec/resolusi yang kompatibel.',
        detail:
          String(error.message).slice(0, 700)
      });

    } finally {

      for (const file of req.files || []) {
        try {
          fs.unlinkSync(file.path);
        } catch {}
      }

      try {
        fs.unlinkSync(listFile);
      } catch {}
    }
  }
);

app.get('*', (req, res) => {
  res.sendFile(
    path.join(
      ROOT,
      'public',
      'index.html'
    )
  );
});

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Palend Downloader listening on ${PORT}`
    );
  }
);
