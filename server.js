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

[UP, OUT].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({
  dest: UP,
  limits: { fileSize: 500 * 1024 * 1024, files: 20 }
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function safeUnlink(file) {
  if (!file) return;
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
}

function createYoutubeCookiesFile() {
  const encoded = process.env.YOUTUBE_COOKIES_B64;
  if (!encoded) return null;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palend-youtube-'));
  const file = path.join(dir, 'cookies.txt');

  try {
    const cookieData = Buffer.from(encoded, 'base64').toString('utf8');
    if (!cookieData.includes('# Netscape HTTP Cookie File')) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error('Format cookies tidak valid. Gunakan cookies.txt format Netscape.');
    }
    fs.writeFileSync(file, cookieData, { encoding: 'utf8', mode: 0o600 });
    return { file, dir };
  } catch (error) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function removeYoutubeCookies(info) {
  if (!info) return;
  try { fs.rmSync(info.dir, { recursive: true, force: true }); } catch {}
}

function getPlatform(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'youtu.be' || host.includes('youtube.com')) return 'youtube';
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('instagram.com')) return 'instagram';
    if (host === 'fb.watch' || host.includes('facebook.com')) return 'facebook';
    if (host.includes('twitter.com') || host.includes('x.com')) return 'twitter';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function supportedUrl(url) {
  return getPlatform(url) !== 'unknown';
}

function findFile(prefix) {
  const found = fs.readdirSync(OUT).find((name) => name.startsWith(prefix));
  return found ? path.join(OUT, found) : null;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'online',
    service: 'Palend Downloader',
    youtubeCookiesConfigured: Boolean(process.env.YOUTUBE_COOKIES_B64),
    time: new Date().toISOString()
  });
});

app.post('/api/download', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const format = String(req.body?.format || 'mp4').toLowerCase() === 'mp3' ? 'mp3' : 'mp4';

  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: 'Link video tidak valid.' });
  }

  const platform = getPlatform(url);
  if (!supportedUrl(url)) {
    return res.status(400).json({
      ok: false,
      error: 'Link belum didukung. Gunakan YouTube, TikTok, Instagram, Facebook, atau X.'
    });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const sourceTemplate = path.join(OUT, `${id}-source.%(ext)s`);
  let cookieInfo = null;
  let sourceFile = null;

  try {
    console.log('DOWNLOAD PLATFORM:', platform);
    console.log('DOWNLOAD URL:', url);

    cookieInfo = createYoutubeCookiesFile();

    const args = [
      '--no-playlist',
      '--restrict-filenames',
      '--no-warnings',
      '--newline',
      '-o', sourceTemplate
    ];

    if (cookieInfo && platform === 'youtube') {
      args.push('--cookies', cookieInfo.file);
    }

    if (format === 'mp3') {
      args.push(
        '-f', 'ba/b',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0'
      );
    } else {
      // Prioritaskan H.264 + AAC. Jika tidak tersedia, ambil format terbaik lalu transcode.
      args.push(
        '-f',
        'bv*[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a]/' +
        'bv*[vcodec^=avc1][ext=mp4]+ba/' +
        'b[ext=mp4][vcodec^=avc1]/' +
        'bv*+ba/b',
        '--merge-output-format', 'mp4'
      );
    }

    args.push(url);
    await run(process.env.YTDLP_BIN || 'yt-dlp', args);

    sourceFile = findFile(`${id}-source`);
    if (!sourceFile) throw new Error('File hasil download tidak ditemukan.');

    const finalFile = path.join(OUT, `${id}.${format}`);

    if (format === 'mp3') {
      await run(process.env.FFMPEG_BIN || 'ffmpeg', [
        '-y', '-i', sourceFile,
        '-vn', '-c:a', 'libmp3lame', '-b:a', '192k',
        finalFile
      ]);
    } else {
      // Paksa H.264/AVC + AAC + yuv420p + faststart agar kompatibel dengan pemutar HP.
      await run(process.env.FFMPEG_BIN || 'ffmpeg', [
        '-y', '-i', sourceFile,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-level', '4.0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-movflags', '+faststart',
        finalFile
      ]);
    }

    safeUnlink(sourceFile);
    sourceFile = null;

    const filename = path.basename(finalFile);
    return res.json({
      ok: true,
      platform,
      format,
      filename,
      download: '/api/file/' + encodeURIComponent(filename)
    });
  } catch (error) {
    const detail = String(error.message || '');
    console.error('DOWNLOAD ERROR:', detail);

    let message = 'Gagal memproses video.';
    if (/Sign in to confirm|not a bot|authentication|cookies/i.test(detail)) {
      message = 'YouTube meminta autentikasi. Pastikan cookies YouTube di Railway masih valid.';
    } else if (/Requested format is not available/i.test(detail)) {
      message = 'Format video yang diminta tidak tersedia. Coba link video lain.';
    } else if (/ffmpeg|No such file or directory/i.test(detail)) {
      message = 'FFmpeg tidak tersedia atau gagal mengubah video ke format yang kompatibel.';
    }

    return res.status(500).json({ ok: false, error: message, detail: detail.slice(0, 1000) });
  } finally {
    safeUnlink(sourceFile);
    removeYoutubeCookies(cookieInfo);
  }
});

app.get('/api/file/:name', (req, res) => {
  const filename = path.basename(req.params.name);
  const file = path.join(OUT, filename);

  if (!fs.existsSync(file)) {
    return res.status(404).send('File tidak ditemukan atau sudah dibersihkan.');
  }

  res.download(file, filename);
});

app.post('/api/merge', upload.array('videos', 20), async (req, res) => {
  if (!req.files || req.files.length < 2) {
    return res.status(400).json({ ok: false, error: 'Pilih minimal 2 video.' });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const listFile = path.join(UP, `${id}.txt`);
  const outputFile = path.join(OUT, `${id}-palend.mp4`);
  const normalizedFiles = [];

  try {
    // Normalisasi setiap video ke H.264/AAC agar aman saat digabung.
    for (let i = 0; i < req.files.length; i++) {
      const input = req.files[i].path;
      const normalized = path.join(UP, `${id}-part-${i}.mp4`);

      await run(process.env.FFMPEG_BIN || 'ffmpeg', [
        '-y', '-i', input,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
        '-movflags', '+faststart',
        normalized
      ]);

      normalizedFiles.push(normalized);
    }

    const listContent = normalizedFiles.map((file) => {
      const safe = file.replace(/'/g, "'\\''");
      return `file '${safe}'`;
    }).join('\n');

    fs.writeFileSync(listFile, listContent);

    await run(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', '-movflags', '+faststart', outputFile
    ]);

    const filename = path.basename(outputFile);
    return res.json({
      ok: true,
      filename,
      download: '/api/file/' + encodeURIComponent(filename)
    });
  } catch (error) {
    console.error('MERGE ERROR:', error.message);
    return res.status(500).json({
      ok: false,
      error: 'Penggabungan gagal. Pastikan FFmpeg tersedia dan video dapat diproses.',
      detail: String(error.message).slice(0, 1000)
    });
  } finally {
    for (const file of req.files || []) safeUnlink(file.path);
    safeUnlink(listFile);
    for (const file of normalizedFiles) safeUnlink(file);
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Palend Downloader listening on ${PORT}`);
});
      
