const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'palend-downloads');

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function isAllowedUrl(value) {
  try {
    const u = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    const allowed = [
      'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
      'youtube-nocookie.com', 'www.youtube-nocookie.com',
      'tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
      'instagram.com', 'www.instagram.com',
      'facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch',
      'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'
    ];
    return allowed.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

function platformFromUrl(value) {
  const host = new URL(value).hostname.toLowerCase();
  if (host.includes('youtube') || host === 'youtu.be') return 'youtube';
  if (host.includes('tiktok')) return 'tiktok';
  if (host.includes('instagram')) return 'instagram';
  if (host.includes('facebook') || host === 'fb.watch') return 'facebook';
  if (host === 'twitter.com' || host.endsWith('.twitter.com') || host === 'x.com' || host.endsWith('.x.com')) return 'twitter';
  return 'unknown';
}

function runCommand(command, args, timeout = 8 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', b => { stdout += b.toString(); if (stdout.length > 200000) stdout = stdout.slice(-200000); });
    child.stderr.on('data', b => { stderr += b.toString(); if (stderr.length > 200000) stderr = stderr.slice(-200000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Proses terlalu lama dan dihentikan.')); }, timeout);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function outputTemplate(jobId) { return path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`); }

function findDownloadedFile(jobId) {
  const files = fs.readdirSync(DOWNLOAD_DIR)
    .filter(n => n.startsWith(jobId + '.'))
    .map(n => path.join(DOWNLOAD_DIR, n))
    .filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (!files.length) return null;
  return files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

function cleanupJob(jobId) {
  for (const name of fs.readdirSync(DOWNLOAD_DIR)) {
    if (!name.startsWith(jobId + '.')) continue;
    try { fs.unlinkSync(path.join(DOWNLOAD_DIR, name)); } catch {}
  }
}

function publicBaseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function ytDlpArgs(url, output) {
  return [
    '--no-playlist', '--no-warnings', '--ignore-config',
    '--js-runtimes', 'deno',
    '--remote-components', 'ejs:npm',
    '-f',
    'bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]/' +
    'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/' +
    'b[ext=mp4][height<=1080]/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--retries', '3', '--fragment-retries', '3', '--extractor-retries', '2',
    '--socket-timeout', '30', '--concurrent-fragments', '4',
    '--restrict-filenames', '--print', 'after_move:filepath',
    '-o', output, url
  ];
}

function usefulError(stderr) {
  const text = String(stderr || '').trim();
  if (/Sign in to confirm|not a bot|captcha/i.test(text)) return 'Platform meminta verifikasi. Silakan coba video publik lain.';
  if (/Requested format is not available/i.test(text)) return 'Format video tidak tersedia. Silakan coba video lain.';
  if (/Video unavailable|Private video|members-only/i.test(text)) return 'Video tidak tersedia untuk publik.';
  if (/Unsupported URL/i.test(text)) return 'Link tidak didukung.';
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(s => !s.startsWith('[debug]'));
  return lines.slice(-3).join(' ') || 'Video tidak dapat diproses.';
}

async function downloadVideo(url, jobId) {
  console.log('DOWNLOAD PLATFORM:', platformFromUrl(url));
  console.log('DOWNLOAD URL:', url);
  const result = await runCommand('yt-dlp', ytDlpArgs(url, outputTemplate(jobId)));
  if (result.code !== 0) {
    console.error('YT-DLP ERROR:', result.stderr);
    throw new Error(usefulError(result.stderr));
  }
  const file = findDownloadedFile(jobId);
  if (!file) throw new Error('Video selesai diproses tetapi file hasil tidak ditemukan.');
  if (path.extname(file).toLowerCase() !== '.mp4') throw new Error('Server menghasilkan format yang tidak kompatibel.');
  return file;
}

async function handleDownload(req, res) {
  const url = req.body?.url || req.query?.url;
  const format = String(req.body?.format || req.query?.format || 'mp4').toLowerCase();
  if (!url) return res.status(400).json({ success: false, error: 'Link video belum diisi.' });
  if (!isAllowedUrl(url)) return res.status(400).json({ success: false, error: 'Link tidak didukung. Gunakan YouTube, TikTok, Instagram, Facebook, atau X.' });
  if (format !== 'mp4') return res.status(400).json({ success: false, error: 'Saat ini format yang tersedia adalah MP4.' });

  const jobId = crypto.randomBytes(10).toString('hex');
  try {
    const file = await downloadVideo(String(url).trim(), jobId);
    const downloadUrl = `${publicBaseUrl(req)}/downloads/${path.basename(file)}`;
    return res.json({ success: true, ok: true, format: 'mp4', filename: path.basename(file), downloadUrl, url: downloadUrl });
  } catch (err) {
    cleanupJob(jobId);
    console.error('DOWNLOAD ERROR:', err);
    return res.status(500).json({ success: false, ok: false, error: err.message || 'Gagal memproses video.' });
  }
}

app.post('/api/download', handleDownload);
app.post('/download', handleDownload);
app.post('/api/download-video', handleDownload);

app.get('/health', (req, res) => res.json({ ok: true, status: 'online', service: 'Palend Downloader', time: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.json({ ok: true, status: 'online', service: 'Palend Downloader', time: new Date().toISOString() }));

app.get('/downloads/:file', (req, res) => {
  const name = path.basename(req.params.file);
  if (!/^[a-f0-9]{20}\.mp4$/i.test(name)) return res.status(404).send('File tidak ditemukan.');
  const file = path.join(DOWNLOAD_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).send('File sudah tidak tersedia.');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
});

if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));
app.use((req, res) => {
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (req.method === 'GET' && fs.existsSync(index)) return res.sendFile(index);
  res.status(404).json({ success: false, error: 'Endpoint tidak ditemukan.' });
});

setInterval(() => {
  const now = Date.now();
  for (const name of fs.readdirSync(DOWNLOAD_DIR)) {
    const file = path.join(DOWNLOAD_DIR, name);
    try { if (now - fs.statSync(file).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(file); } catch {}
  }
}, 5 * 60 * 1000).unref();

app.listen(PORT, '0.0.0.0', () => console.log(`Palend Downloader aktif di port ${PORT}`));
