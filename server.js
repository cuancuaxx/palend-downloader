const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const UPLOAD_DIR = path.join(ROOT, "uploads");

for (const dir of [DOWNLOAD_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR));

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    service: "Palend Downloader",
    time: new Date().toISOString()
  });
});

/*
|--------------------------------------------------------------------------
| DOWNLOAD FILE
|--------------------------------------------------------------------------
*/

app.get("/downloads/:file", (req, res) => {
  const filename = path.basename(req.params.file);
  const file = path.join(DOWNLOAD_DIR, filename);

  if (!fs.existsSync(file)) {
    return res.status(404).json({
      ok: false,
      error: "File tidak ditemukan."
    });
  }

  res.download(file, filename);
});

/*
|--------------------------------------------------------------------------
| YT-DLP RUNNER
|--------------------------------------------------------------------------
*/

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const command = "python3";

    const finalArgs = [
      "-m",
      "yt_dlp",
      "--no-playlist",
      "--no-warnings",
      "--newline",
      ...args
    ];

    console.log("Running:", command, finalArgs.join(" "));

    const child = spawn(command, finalArgs);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", data => {
      stdout += data.toString();
      console.log(data.toString().trim());
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
      console.error(data.toString().trim());
    });

    child.on("error", err => {
      reject(err);
    });

    child.on("close", code => {
      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
      } else {
        reject(
          new Error(
            stderr.trim() ||
            stdout.trim() ||
            `yt-dlp keluar dengan kode ${code}`
          )
        );
      }
    });
  });
}

/*
|--------------------------------------------------------------------------
| DOWNLOAD VIDEO
|--------------------------------------------------------------------------
*/

app.post("/api/download", async (req, res) => {
  try {
    const { url, format } = req.body || {};

    if (!url) {
      return res.status(400).json({
        ok: false,
        error: "Link video belum diisi."
      });
    }

    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({
        ok: false,
        error: "URL tidak valid."
      });
    }

    const selectedFormat = format === "mp3" ? "mp3" : "mp4";

    const id = crypto.randomBytes(8).toString("hex");

    let outputTemplate;
    let args;

    if (selectedFormat === "mp3") {
      outputTemplate = path.join(
        DOWNLOAD_DIR,
        `${id}.%(ext)s`
      );

      args = [
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "192K",
        "--ffmpeg-location",
        "/usr/bin/ffmpeg",
        "-o",
        outputTemplate,
        url
      ];
    } else {
      outputTemplate = path.join(
        DOWNLOAD_DIR,
        `${id}.%(ext)s`
      );

      args = [
        "-f",
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--merge-output-format",
        "mp4",
        "--ffmpeg-location",
        "/usr/bin/ffmpeg",
        "-o",
        outputTemplate,
        url
      ];
    }

    await runYtDlp(args);

    let filename = null;

    const files = fs.readdirSync(DOWNLOAD_DIR);

    const candidates = files
      .filter(file => file.startsWith(id))
      .sort((a, b) => {
        const aTime = fs.statSync(
          path.join(DOWNLOAD_DIR, a)
        ).mtimeMs;

        const bTime = fs.statSync(
          path.join(DOWNLOAD_DIR, b)
        ).mtimeMs;

        return bTime - aTime;
      });

    if (candidates.length > 0) {
      filename = candidates[0];
    }

    if (!filename) {
      throw new Error(
        "yt-dlp selesai tetapi file hasil tidak ditemukan."
      );
    }

    const downloadUrl =
      `/downloads/${encodeURIComponent(filename)}`;

    return res.json({
      ok: true,
      message: "Video berhasil diproses.",
      filename,
      download: downloadUrl
    });

  } catch (error) {
    console.error("DOWNLOAD ERROR:", error);

    let message = error.message || "Gagal memproses video.";

    if (
      message.includes("Sign in") ||
      message.includes("LOGIN_REQUIRED")
    ) {
      message =
        "Platform meminta login/cookies. Video tersebut tidak dapat diproses tanpa autentikasi.";
    }

    if (
      message.includes("Unsupported URL")
    ) {
      message =
        "Link tidak didukung atau URL video tidak dikenali.";
    }

    if (
      message.includes("Video unavailable")
    ) {
      message =
        "Video tidak tersedia atau dibatasi oleh pemilik/platform.";
    }

    return res.status(500).json({
      ok: false,
      error: message
    });
  }
});

/*
|--------------------------------------------------------------------------
| MULTER
|--------------------------------------------------------------------------
*/

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const name =
      crypto.randomBytes(8).toString("hex") + ext;

    cb(null, name);
  }
});

const upload = multer({
  storage,

  limits: {
    files: 10,
    fileSize: 200 * 1024 * 1024
  }
});

/*
|--------------------------------------------------------------------------
| MERGE VIDEO
|--------------------------------------------------------------------------
*/

app.post(
  "/api/merge",
  upload.array("videos", 10),
  async (req, res) => {

    const files = req.files || [];

    if (files.length < 2) {
      return res.status(400).json({
        ok: false,
        error: "Minimal 2 video diperlukan."
      });
    }

    const id = crypto.randomBytes(8).toString("hex");

    const output = path.join(
      DOWNLOAD_DIR,
      `${id}-merged.mp4`
    );

    const listFile = path.join(
      UPLOAD_DIR,
      `${id}.txt`
    );

    try {

      /*
       * Buat file concat FFmpeg.
       */
      const lines = files.map(file => {
        const safePath = file.path.replace(/'/g, "'\\''");
        return `file '${safePath}'`;
      });

      fs.writeFileSync(
        listFile,
        lines.join("\n"),
        "utf8"
      );

      await new Promise((resolve, reject) => {

        const ffmpeg = spawn("ffmpeg", [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listFile,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          output
        ]);

        let stderr = "";

        ffmpeg.stderr.on("data", data => {
          stderr += data.toString();
        });

        ffmpeg.on("error", reject);

        ffmpeg.on("close", code => {

          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                stderr.slice(-3000) ||
                "FFmpeg gagal menggabungkan video."
              )
            );
          }

        });

      });

      const downloadUrl =
        `/downloads/${path.basename(output)}`;

      return res.json({
        ok: true,
        message: "Video berhasil digabung.",
        download: downloadUrl
      });

    } catch (error) {

      console.error("MERGE ERROR:", error);

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Gagal menggabungkan video."
      });

    } finally {

      /*
       * Bersihkan file upload.
       */

      for (const file of files) {
        try {
          fs.unlinkSync(file.path);
        } catch {}
      }

      try {
        if (fs.existsSync(listFile)) {
          fs.unlinkSync(listFile);
        }
      } catch {}
    }
  }
);

/*
|--------------------------------------------------------------------------
| CLEAN OLD FILES
|--------------------------------------------------------------------------
*/

function cleanOldFiles() {

  const folders = [
    DOWNLOAD_DIR,
    UPLOAD_DIR
  ];

  const now = Date.now();

  for (const folder of folders) {

    if (!fs.existsSync(folder)) {
      continue;
    }

    for (const file of fs.readdirSync(folder)) {

      const fullPath = path.join(folder, file);

      try {

        const stat = fs.statSync(fullPath);

        const age =
          now - stat.mtimeMs;

        /*
         * Hapus file lebih lama dari 30 menit.
         */

        if (age > 30 * 60 * 1000) {
          fs.unlinkSync(fullPath);
        }

      } catch {}
    }
  }
}

setInterval(
  cleanOldFiles,
  10 * 60 * 1000
);

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use((err, req, res, next) => {

  console.error("SERVER ERROR:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    ok: false,
    error: err.message || "Terjadi kesalahan server."
  });
});

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.listen(PORT, "0.0.0.0", () => {

  console.log(
    `Palend Downloader aktif pada port ${PORT}`
  );

});
