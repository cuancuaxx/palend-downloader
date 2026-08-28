const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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

app.use(express.json());
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
        reject(new Error(stderr || `Process exited with code ${code}`));
      } else {
        resolve({
          stdout,
          stderr
        });
      }
    });
  });
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'online',
    service: 'Palend Downloader',
    time: new Date().toISOString()
  });
});

// Download video
app.post('/api/download', async (req, res) => {
  const { url, format = 'mp4' } = req.body || {};

  // INI BAGIAN YANG DIPERBAIKI
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({
      ok: false,
      error: 'URL tidak valid.'
    });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const template = path.join(OUT, id + '.%(ext)s');

  try {
    const args = [
      '--no-playlist',
      '--restrict-filenames',
      '--no-warnings',
      '-o',
      template
    ];

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

    const file = fs
      .readdirSync(OUT)
      .find((name) => name.startsWith(id + '.'));

    if (!file) {
      throw new Error('File hasil tidak ditemukan');
    }

    res.json({
      ok: true,
      filename: file,
      download: '/api/file/' + encodeURIComponent(file)
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error:
        'Gagal memproses. Pastikan yt-dlp dan FFmpeg tersedia serta URL didukung.',
      detail: String(error.message || '').slice(0, 700)
    });
  }
});

// Download hasil file
app.get('/api/file/:name', (req, res) => {
  const file = path.join(
    OUT,
    path.basename(req.params.name)
  );

  if (fs.existsSync(file)) {
    res.download(file, path.basename(file));
  } else {
    res.status(404).send('File tidak ditemukan');
  }
});

// Merge videos
app.post('/api/merge', upload.array('videos', 20), async (req, res) => {
  if (!req.files || req.files.length < 2) {
    return res.status(400).json({
      ok: false,
      error: 'Pilih minimal 2 video.'
    });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const list = path.join(UP, id + '.txt');
  const output = path.join(OUT, id + '-palend.mp4');

  try {
    const content = req.files
      .map((file) => {
        return `file '${file.path.replace(/'/g, "'\\''")}'`;
      })
      .join('\n');

    fs.writeFileSync(list, content);

    await run(
      process.env.FFMPEG_BIN || 'ffmpeg',
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-c',
        'copy',
        output
      ]
    );

    res.json({
      ok: true,
      filename: path.basename(output),
      download:
        '/api/file/' +
        encodeURIComponent(path.basename(output))
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error:
        'Penggabungan gagal. Coba video dengan codec/resolusi yang kompatibel.',
      detail: String(error.message || '').slice(0, 700)
    });

  } finally {
    (req.files || []).forEach((file) => {
      try {
        fs.unlinkSync(file.path);
      } catch {}
    });

    try {
      fs.unlinkSync(list);
    } catch {}
  }
});

// Frontend
app.get('*', (req, res) => {
  res.sendFile(
    path.join(ROOT, 'public', 'index.html')
  );
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    'Palend Downloader listening on port ' + PORT
  );
});
