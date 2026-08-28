const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const UPLOAD_DIR = path.join(ROOT, 'uploads');
const OUTPUT_DIR = path.join(ROOT, 'outputs');

const YTDLP_BIN =
  process.env.YTDLP_BIN || 'yt-dlp';

const FFMPEG_BIN =
  process.env.FFMPEG_BIN || 'ffmpeg';

fs.mkdirSync(UPLOAD_DIR, {
  recursive: true
});

fs.mkdirSync(OUTPUT_DIR, {
  recursive: true
});

/* =========================================================
   EXPRESS
========================================================= */

app.use(
  express.json({
    limit: '2mb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '2mb'
  })
);

app.use(
  express.static(
    path.join(ROOT, 'public')
  )
);

/* =========================================================
   MULTER
========================================================= */

const upload = multer({
  dest: UPLOAD_DIR,

  limits: {
    fileSize:
      500 * 1024 * 1024,

    files: 20
  }
});

/* =========================================================
   COMMAND RUNNER
========================================================= */

function run(command, args) {
  return new Promise(
    (resolve, reject) => {

      console.log(
        '[RUN]',
        command,
        args.join(' ')
      );

      const child = spawn(
        command,
        args,
        {
          env: {
            ...process.env
          }
        }
      );

      let stdout = '';
      let stderr = '';

      child.stdout.on(
        'data',
        data => {
          stdout +=
            data.toString();
        }
      );

      child.stderr.on(
        'data',
        data => {
          stderr +=
            data.toString();
        }
      );

      child.on(
        'error',
        error => {
          reject(error);
        }
      );

      child.on(
        'close',
        code => {

          if (code !== 0) {

            reject(
              new Error(
                stderr.trim() ||
                stdout.trim() ||
                `Command gagal dengan kode ${code}`
              )
            );

            return;
          }

          resolve({
            stdout,
            stderr
          });
        }
      );
    }
  );
}

/* =========================================================
   PLATFORM DETECTION
========================================================= */

function detectPlatform(url) {

  const value =
    String(url)
      .toLowerCase();

  if (
    value.includes(
      'youtube.com'
    ) ||
    value.includes(
      'youtu.be'
    ) ||
    value.includes(
      'youtube-nocookie.com'
    )
  ) {
    return 'youtube';
  }

  if (
    value.includes(
      'tiktok.com'
    ) ||
    value.includes(
      'vm.tiktok.com'
    ) ||
    value.includes(
      'vt.tiktok.com'
    )
  ) {
    return 'tiktok';
  }

  if (
    value.includes(
      'instagram.com'
    ) ||
    value.includes(
      'instagr.am'
    )
  ) {
    return 'instagram';
  }

  if (
    value.includes(
      'facebook.com'
    ) ||
    value.includes(
      'fb.watch'
    ) ||
    value.includes(
      'm.facebook.com'
    )
  ) {
    return 'facebook';
  }

  if (
    value.includes(
      'twitter.com'
    ) ||
    value.includes(
      'x.com'
    )
  ) {
    return 'twitter';
  }

  return 'unknown';
}

/* =========================================================
   URL VALIDATION
========================================================= */

function isValidUrl(url) {

  try {

    const parsed =
      new URL(url);

    return (
      parsed.protocol ===
        'http:' ||
      parsed.protocol ===
        'https:'
    );

  } catch {

    return false;
  }
}

/* =========================================================
   COOKIE FILE CREATOR
========================================================= */

/*
   Railway Variable:

   YOUTUBE_COOKIES_B64

   Berisi cookies.txt dalam format
   Netscape/Mozilla yang sudah di-Base64.
*/

function createCookieFile(
  environmentVariable
) {

  const encoded =
    process.env[
      environmentVariable
    ];

  if (!encoded) {
    return null;
  }

  const tempDir =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        'palend-cookie-'
      )
    );

  const cookieFile =
    path.join(
      tempDir,
      'cookies.txt'
    );

  try {

    const cookieData =
      Buffer.from(
        encoded.trim(),
        'base64'
      ).toString(
        'utf8'
      );

    if (
      !cookieData.trim()
    ) {
      throw new Error(
        `${environmentVariable} kosong`
      );
    }

    const lines =
      cookieData.split(
        /\r?\n/
      );

    /*
       Pertahankan header komentar,
       dan hanya cookie yang memiliki
       minimal 7 field tab-separated.
    */

    const cleaned =
      lines.filter(line => {

        if (
          !line.trim()
        ) {
          return true;
        }

        if (
          line.startsWith('#')
        ) {
          return true;
        }

        const parts =
          line.split('\t');

        return (
          parts.length >= 7
        );
      });

    const output =
      cleaned.join('\n');

    /*
       Validasi sederhana.
    */

    const hasHeader =
      output.includes(
        '# Netscape HTTP Cookie File'
      ) ||
      output.includes(
        '# HTTP Cookie File'
      );

    const cookieRows =
      cleaned.filter(
        line => {

          if (
            !line.trim()
          ) {
            return false;
          }

          if (
            line.startsWith('#')
          ) {
            return false;
          }

          return (
            line.split('\t')
              .length >= 7
          );
        }
      );

    if (
      !hasHeader &&
      cookieRows.length === 0
    ) {

      throw new Error(
        `${environmentVariable} bukan cookies.txt Netscape yang valid`
      );
    }

    fs.writeFileSync(
      cookieFile,
      output,
      {
        encoding: 'utf8',
        mode: 0o600
      }
    );

    console.log(
      `[COOKIE] ${environmentVariable} loaded`
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

function removeCookieFile(
  cookieInfo
) {

  if (!cookieInfo) {
    return;
  }

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
   BUILD YT-DLP ARGUMENTS
========================================================= */

function buildYtDlpArgs({
  platform,
  url,
  outputTemplate,
  format,
  cookieInfo
}) {

  const args = [

    '--no-playlist',

    '--restrict-filenames',

    '--no-warnings',

    '--newline',

    '--no-part',

    '--ignore-config',

    '-o',

    outputTemplate
  ];

  /* =======================================================
     YOUTUBE
  ======================================================= */

  if (
    platform === 'youtube'
  ) {

    /*
       Gunakan cookies YouTube jika tersedia.
    */

    if (cookieInfo) {

      args.push(
        '--cookies',
        cookieInfo.file
      );
    }

    /*
       Coba client default + web_embedded.

       web_embedded adalah salah satu client
       yang tersedia pada extractor YouTube.
    */

    args.push(
      '--extractor-args',
      'youtube:player_client=default,web_embedded'
    );

    /*
       Hindari playlist.
    */

    args.push(
      '--no-playlist'
    );
  }

  /* =======================================================
     FORMAT MP3
  ======================================================= */

  if (
    String(format)
      .toLowerCase() ===
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

  /* =======================================================
     FORMAT MP4
  ======================================================= */

  else {

    args.push(
      '-f',
      'bv*+ba/b',

      '--merge-output-format',
      'mp4'
    );
  }

  args.push(url);

  return args;
}

/* =========================================================
   FIND OUTPUT FILE
========================================================= */

function findOutputFile(
  id
) {

  const files =
    fs.readdirSync(
      OUTPUT_DIR
    );

  return files.find(
    file =>
      file.startsWith(
        `${id}.`
      )
  );
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/api/health',
  (req, res) => {

    res.json({

      ok: true,

      status: 'online',

      service:
        'Palend Downloader',

      youtubeCookiesConfigured:
        Boolean(
          process.env
            .YOUTUBE_COOKIES_B64
        ),

      supportedPlatforms: [
        'YouTube',
        'TikTok',
        'Instagram',
        'Facebook',
        'X/Twitter'
      ],

      time:
        new Date()
          .toISOString()
    });
  }
);

/* =========================================================
   PLATFORM
========================================================= */

app.get(
  '/api/platform',
  (req, res) => {

    const url =
      req.query.url;

    if (
      !url
    ) {

      return res.status(400)
        .json({
          ok: false,
          error:
            'URL wajib diisi.'
        });
    }

    res.json({

      ok: true,

      platform:
        detectPlatform(url)
    });
  }
);

/* =========================================================
   VIDEO INFO
========================================================= */

app.get(
  '/api/info',
  async (req, res) => {

    const url =
      req.query.url;

    if (
      !url ||
      !isValidUrl(url)
    ) {

      return res.status(400)
        .json({

          ok: false,

          error:
            'URL tidak valid.'
        });
    }

    const platform =
      detectPlatform(url);

    if (
      platform ===
      'unknown'
    ) {

      return res.status(400)
        .json({

          ok: false,

          error:
            'Platform belum didukung.'
        });
    }

    let cookieInfo =
      null;

    try {

      /*
         Hanya YouTube yang menggunakan
         YOUTUBE_COOKIES_B64.
      */

      if (
        platform ===
        'youtube'
      ) {

        cookieInfo =
          createCookieFile(
            'YOUTUBE_COOKIES_B64'
          );
      }

      const args = [

        '--no-playlist',

        '--no-warnings',

        '--skip-download',

        '--dump-single-json',

        '--no-simulate',

        '--ignore-config'
      ];

      if (
        platform ===
        'youtube'
      ) {

        if (
          cookieInfo
        ) {

          args.push(
            '--cookies',
            cookieInfo.file
          );
        }

        args.push(
          '--extractor-args',
          'youtube:player_client=default,web_embedded'
        );
      }

      args.push(url);

      const result =
        await run(
          YTDLP_BIN,
          args
        );

      let info;

      try {

        info =
          JSON.parse(
            result.stdout
          );

      } catch {

        throw new Error(
          'yt-dlp menghasilkan data JSON yang tidak valid.'
        );
      }

      return res.json({

        ok: true,

        platform,

        id:
          info.id || null,

        title:
          info.title ||
          'Video',

        thumbnail:
          info.thumbnail ||
          null,

        duration:
          info.duration ||
          null,

        uploader:
          info.uploader ||
          info.channel ||
          info.creator ||
          null
      });

    } catch (error) {

      console.error(
        '[INFO ERROR]',
        error.message
      );

      return res.status(500)
        .json({

          ok: false,

          platform,

          error:
            'Gagal mengambil informasi video.',

          detail:
            String(
              error.message
            ).slice(0, 1000)
        });

    } finally {

      removeCookieFile(
        cookieInfo
      );
    }
  }
);

/* =========================================================
   DOWNLOAD
========================================================= */

app.post(
  '/api/download',
  async (req, res) => {

    const {
      url,
      format = 'mp4'
    } =
      req.body || {};

    /* -------------------------------------------------------
       VALIDASI
    ------------------------------------------------------- */

    if (
      !url
    ) {

      return res.status(400)
        .json({

          ok: false,

          error:
            'URL wajib diisi.'
        });
    }

    if (
      !isValidUrl(url)
    ) {

      return res.status(400)
        .json({

          ok: false,

          error:
            'URL tidak valid.'
        });
    }

    const platform =
      detectPlatform(url);

    if (
      platform ===
      'unknown'
    ) {

      return res.status(400)
        .json({

          ok: false,

          error:
            'Platform belum didukung.'
        });
    }

    /* -------------------------------------------------------
       ID FILE
    ------------------------------------------------------- */

    const id =
      crypto
        .randomBytes(10)
        .toString('hex');

    const template =
      path.join(
        OUTPUT_DIR,
        `${id}.%(ext)s`
      );

    let cookieInfo =
      null;

    try {

      /* -----------------------------------------------------
         COOKIES YOUTUBE
      ----------------------------------------------------- */

      if (
        platform ===
        'youtube'
      ) {

        cookieInfo =
          createCookieFile(
            'YOUTUBE_COOKIES_B64'
          );
      }

      /* -----------------------------------------------------
         BUILD ARGUMENT
      ----------------------------------------------------- */

      const args =
        buildYtDlpArgs({

          platform,

          url,

          outputTemplate:
            template,

          format,

          cookieInfo
        });

      console.log(
        `[DOWNLOAD] Platform: ${platform}`
      );

      console.log(
        `[DOWNLOAD] URL: ${url}`
      );

      /* -----------------------------------------------------
         RUN YT-DLP
      ----------------------------------------------------- */

      await run(
        YTDLP_BIN,
        args
      );

      /* -----------------------------------------------------
         CARI FILE
      ----------------------------------------------------- */

      const filename =
        findOutputFile(id);

      if (
        !filename
      ) {

        throw new Error(
          'File hasil download tidak ditemukan.'
        );
      }

      console.log(
        `[SUCCESS] ${filename}`
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
        '[DOWNLOAD ERROR]',
        detail
      );

      let message =
        'Gagal memproses video.';

      /* -----------------------------------------------------
         YOUTUBE AUTH
      ----------------------------------------------------- */

      if (
        detail.includes(
          'Sign in to confirm'
        ) ||
        detail.includes(
          'not a bot'
        )
      ) {

        message =
          'YouTube meminta autentikasi. Cookies atau metode autentikasi YouTube perlu diperbarui.';
      }

      /* -----------------------------------------------------
         PAGE RELOAD
      ----------------------------------------------------- */

      else if (
        detail.includes(
          'The page needs to be reloaded'
        )
      ) {

        message =
          'YouTube meminta halaman dimuat ulang. Cookies/client YouTube mungkin sudah tidak valid atau YouTube membutuhkan mekanisme autentikasi tambahan.';
      }

      /* -----------------------------------------------------
         COOKIE ERROR
      ----------------------------------------------------- */

      else if (
        detail.includes(
          'cookie'
        ) ||
        detail.includes(
          'cookies'
        )
      ) {

        message =
          'Cookies tidak dapat digunakan. Pastikan cookies.txt berformat Netscape dan masih aktif.';
      }

      /* -----------------------------------------------------
         UNSUPPORTED URL
      ----------------------------------------------------- */

      else if (
        detail.includes(
          'Unsupported URL'
        )
      ) {

        message =
          'URL tersebut tidak dapat diproses oleh yt-dlp.';
      }

      /* -----------------------------------------------------
         INSTAGRAM
      ----------------------------------------------------- */

      else if (
        platform ===
        'instagram'
      ) {

        message =
          'Instagram menolak permintaan atau konten tidak dapat diakses. Pastikan Reel/postingan bersifat publik dan URL benar.';
      }

      /* -----------------------------------------------------
         TIKTOK
      ----------------------------------------------------- */

      else if (
        platform ===
        'tiktok'
      ) {

        message =
          'TikTok menolak permintaan atau URL tidak dapat diproses. Pastikan video dapat diakses secara publik.';
      }

      /* -----------------------------------------------------
         FFMPEG
      ----------------------------------------------------- */

      else if (
        detail
          .toLowerCase()
          .includes(
            'ffmpeg'
          )
      ) {

        message =
          'FFmpeg tidak tersedia atau gagal menggabungkan audio dan video.';
      }

      return res.status(500)
        .json({

          ok: false,

          platform,

          error: message,

          detail:
            detail.slice(
              0,
              1200
            )
        });

    } finally {

      removeCookieFile(
        cookieInfo
      );
    }
  }
);

/* =========================================================
   DOWNLOAD RESULT FILE
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
        OUTPUT_DIR,
        filename
      );

    /*
       Pastikan file berada di OUTPUT_DIR.
    */

    if (
      !file.startsWith(
        OUTPUT_DIR
      )
    ) {

      return res.status(403)
        .send(
          'Akses ditolak.'
        );
    }

    if (
      !fs.existsSync(file)
    ) {

      return res.status(404)
        .send(
          'File tidak ditemukan atau sudah kedaluwarsa.'
        );
    }

    res.download(
      file,
      filename,
      error => {

        if (error) {

          console.error(
            '[FILE ERROR]',
            error.message
          );
        }
      }
    );
  }
);

/* ===============
