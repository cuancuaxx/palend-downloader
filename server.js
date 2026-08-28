const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(ROOT, "public")));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 20
  }
});

/* =========================================================
   RUN COMMAND
========================================================= */

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
            stdout.trim() ||
            `Command exited with code ${code}`
          )
        );
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
   COOKIE HELPER
========================================================= */

function createCookieFile(base64, prefix) {
  if (!base64) {
    return null;
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );

  const cookieFile = path.join(
    tempDir,
    "cookies.txt"
  );

  try {
    const decoded = Buffer
      .from(base64.trim(), "base64")
      .toString("utf8");

    const validHeader =
      decoded.includes("# Netscape HTTP Cookie File") ||
      decoded.includes("# HTTP Cookie File");

    if (!validHeader) {
      throw new Error(
        "Cookie bukan format Netscape/Mozilla."
      );
    }

    fs.writeFileSync(
      cookieFile,
      decoded,
      {
        encoding: "utf8",
        mode: 0o600
      }
    );

    return {
      file: cookieFile,
      dir: tempDir
    };
  } catch (error) {
    fs.rmSync(
      tempDir,
      {
        recursive: true,
        force: true
      }
    );

    throw error;
  }
}

function removeCookieFile(info) {
  if (!info) {
    return;
  }

  try {
    fs.rmSync(
      info.dir,
      {
        recursive: true,
        force: true
      }
    );
  } catch (error) {
    console.error(
      "COOKIE CLEANUP ERROR:",
      error.message
    );
  }
}

/* =========================================================
   DETECT PLATFORM
========================================================= */

function detectPlatform(url) {
  const value = url.toLowerCase();

  if (
    value.includes("youtube.com") ||
    value.includes("youtu.be")
  ) {
    return "youtube";
  }

  if (
    value.includes("tiktok.com") ||
    value.includes("vm.tiktok.com") ||
    value.includes("vt.tiktok.com")
  ) {
    return "tiktok";
  }

  if (
    value.includes("instagram.com")
  ) {
    return "instagram";
  }

  return "other";
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    service: "Palend Downloader",
    youtubeCookies: Boolean(
      process.env.YOUTUBE_COOKIES_B64
    ),
    instagramCookies: Boolean(
      process.env.INSTAGRAM_COOKIES_B64
    ),
    tiktokCookies: Boolean(
      process.env.TIKTOK_COOKIES_B64
    ),
    ytDlp: process.env.YTDLP_BIN || "yt-dlp",
    ffmpeg: process.env.FFMPEG_BIN || "ffmpeg",
    time: new Date().toISOString()
  });
});

/* =========================================================
   DOWNLOAD
========================================================= */

app.post(
  "/api/download",
  async (req, res) => {

    const url =
      typeof req.body?.url === "string"
        ? req.body.url.trim()
        : "";

    const format =
      req.body?.format === "mp3"
        ? "mp3"
        : "mp4";

    if (!url) {
      return res.status(400).json({
        ok: false,
        error: "URL video belum diisi."
      });
    }

    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({
        ok: false,
        error: "URL harus dimulai dengan http:// atau https://."
      });
    }

    const platform = detectPlatform(url);

    const id =
      crypto.randomBytes(8).toString("hex");

    const outputTemplate = path.join(
      OUTPUT_DIR,
      `${id}.%(ext)s`
    );

    let cookieInfo = null;

    try {

      /* ---------------------------------------------------
         PILIH COOKIE SESUAI PLATFORM
      --------------------------------------------------- */

      if (platform === "youtube") {

        cookieInfo = createCookieFile(
          process.env.YOUTUBE_COOKIES_B64,
          "palend-youtube-"
        );

      } else if (platform === "instagram") {

        cookieInfo = createCookieFile(
          process.env.INSTAGRAM_COOKIES_B64,
          "palend-instagram-"
        );

      } else if (platform === "tiktok") {

        cookieInfo = createCookieFile(
          process.env.TIKTOK_COOKIES_B64,
          "palend-tiktok-"
        );
      }

      /* ---------------------------------------------------
         BASE ARGUMENTS
      --------------------------------------------------- */

      const args = [
        "--no-playlist",
        "--restrict-filenames",
        "--newline",
        "--no-warnings",
        "--ignore-errors",
        "-o",
        outputTemplate
      ];

      /* ---------------------------------------------------
         COOKIE
      --------------------------------------------------- */

      if (cookieInfo) {
        args.push(
          "--cookies",
          cookieInfo.file
        );
      }

      /* ---------------------------------------------------
         USER AGENT
      --------------------------------------------------- */

      if (process.env.YTDLP_USER_AGENT) {
        args.push(
          "--user-agent",
          process.env.YTDLP_USER_AGENT
        );
      }

      /* ---------------------------------------------------
         FORMAT
      --------------------------------------------------- */

      if (format === "mp3") {

        args.push(
          "-x",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "0"
        );

      } else {

        args.push(
          "-f",
          "bv*+ba/b",
          "--merge-output-format",
          "mp4"
        );
      }

      /* ---------------------------------------------------
         URL HARUS TERAKHIR
      --------------------------------------------------- */

      args.push(url);

      console.log(
        "DOWNLOAD PLATFORM:",
        platform
      );

      console.log(
        "DOWNLOAD URL:",
        url
      );

      /* ---------------------------------------------------
         RUN YT-DLP
      --------------------------------------------------- */

      await runCommand(
        process.env.YTDLP_BIN || "yt-dlp",
        args
      );

      /* ---------------------------------------------------
         CARI FILE HASIL
      --------------------------------------------------- */

      const files =
        fs.readdirSync(OUTPUT_DIR);

      const filename =
        files.find((file) =>
          file.startsWith(`${id}.`)
        );

      if (!filename) {
        throw new Error(
          "File hasil download tidak ditemukan."
        );
      }

      return res.json({
        ok: true,
        platform,
        format,
        filename,
        download:
          "/api/file/" +
          encodeURIComponent(filename)
      });

    } catch (error) {

      const detail =
        String(error.message || "");

      console.error(
        "DOWNLOAD ERROR:",
        detail
      );

      let message =
        "Gagal memproses video.";

      if (
        detail.includes("Sign in to confirm") ||
        detail.includes("not a bot") ||
        detail.includes("authentication")
      ) {

        message =
          "Platform meminta autentikasi. Pastikan cookies masih valid.";

      } else if (
        detail.includes("Unsupported URL")
      ) {

        message =
          "URL tidak didukung oleh yt-dlp.";

      } else if (
        detail.includes("page needs to be reloaded")
      ) {

        message =
          "Halaman platform meminta dimuat ulang. Coba lagi atau perbarui yt-dlp.";

      } else if (
        detail.includes("ffmpeg")
      ) {

        message =
          "FFmpeg tidak tersedia atau gagal menjalankan proses.";

      } else if (
        detail.includes("Cookie")
      ) {

        message =
          "Cookie tidak valid atau format cookie salah.";
      }

      return res.status(500).json({
        ok: false,
        platform,
        error: message,
        detail: detail.slice(0, 1200)
      });

    } finally {

      removeCookieFile(cookieInfo);
    }
  }
);

/* =========================================================
   DOWNLOAD FILE
========================================================= */

app.get(
  "/api/file/:name",
  (req, res) => {

    const filename =
      path.basename(req.params.name);

    const file =
      path.join(
        OUTPUT_DIR,
        filename
      );

    if (!fs.existsSync(file)) {
      return res.status(404).send(
        "File tidak ditemukan atau sudah dihapus."
      );
    }

    res.download(
      file,
      filename,
      (error) => {

        if (error) {
          console.error(
            "FILE DOWNLOAD ERROR:",
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
  "/api/merge",
  upload.array("videos", 20),
  async (req, res) => {

    if (
      !req.files ||
      req.files.length < 2
    ) {

      return res.status(400).json({
        ok: false,
        error: "Pilih minimal 2 video."
      });
    }

    const id =
      crypto.randomBytes(8).toString("hex");

    const listFile =
      path.join(
        UPLOAD_DIR,
        `${id}.txt`
      );

    const outputFile =
      path.join(
        OUTPUT_DIR,
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
          .join("\n");

      fs.writeFileSync(
        listFile,
        listContent,
        "utf8"
      );

      await runCommand(
        process.env.FFMPEG_BIN || "ffmpeg",
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listFile,
          "-c",
          "copy",
          outputFile
        ]
      );

      return res.json({
        ok: true,
        filename:
          path.basename(outputFile),
        download:
          "/api/file/" +
          encodeURIComponent(
            path.basename(outputFile)
          )
      });

    } catch (error) {

      console.error(
        "MERGE ERROR:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Penggabungan video gagal.",
        detail:
          String(
            error.message || ""
          ).slice(0, 1000)
      });

    } finally {

      for (
        const file of req.files || []
      ) {

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

/* =========================================================
   404 API
========================================================= */

app.use(
  "/api",
  (req, res) => {

    res.status(404).json({
      ok: false,
      error: "API tidak ditemukan."
    });
  }
);

/* =========================================================
   FRONTEND
========================================================= */

app.get(
  "*",
  (req, res) => {

    res.sendFile(
      path.join(
        ROOT,
        "public",
        "index.html"
      )
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Palend Downloader aktif di port ${PORT}`
    );

  }
);
