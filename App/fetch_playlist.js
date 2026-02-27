/**
 * YouTube Playlist Transcript Fetcher
 * ------------------------------------
 * Fetches transcripts for all videos in a YouTube playlist
 * and saves them as clean .txt files. Skips already-scraped videos.
 *
 * Usage:
 *     node fetch_playlist.js <PLAYLIST_URL>
 *
 * Requirements:
 *     npm install youtube-transcript
 *     yt-dlp must be installed (e.g., via winget or pip)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

// --- CONFIG ---
const OUTPUT_DIR = path.join(__dirname, "..", "transcripts");
const LANGUAGE = "en";
const DELAY_BETWEEN_REQUESTS = [3, 8]; // seconds [min, max]
const COOKIES_FILE = "cookies.txt";
const MAX_CONSECUTIVE_BLOCKS = 3;
// --------------

function sanitizeFilename(name) {
  return name
    .replace(/[\\/*?:"<>|]/g, "")
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getPlaylistVideos(playlistUrl) {
  console.log(`Fetching video list from: ${playlistUrl}`);
  try {
    const stdout = execSync(
      `yt-dlp --flat-playlist --dump-single-json --no-warnings "${playlistUrl}"`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout);
    console.log(`Playlist: ${data.title || "unknown"}`);
    const entries = data.entries || [];
    console.log(`Found ${entries.length} videos.`);
    return entries;
  } catch (err) {
    console.log(`Error fetching playlist: ${err.message}`);
    return [];
  }
}

function getVideoMetadata(videoId) {
  try {
    const stdout = execSync(
      `yt-dlp --no-warnings --print "%(duration)s\n%(upload_date)s" "https://www.youtube.com/watch?v=${videoId}"`,
      { encoding: "utf-8" }
    );
    const lines = stdout.trim().split("\n");
    const meta = { duration: null, uploadDate: null };
    if (lines.length >= 1) {
      const dur = parseInt(lines[0], 10);
      if (!isNaN(dur)) meta.duration = dur;
    }
    if (lines.length >= 2 && lines[1] && lines[1] !== "NA" && lines[1].length === 8) {
      const raw = lines[1];
      meta.uploadDate = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    }
    return meta;
  } catch {
    return { duration: null, uploadDate: null };
  }
}

function fetchTranscriptYtdlp(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-transcript-"));
  try {
    let cmd = `yt-dlp --write-auto-subs --skip-download --sub-lang ${LANGUAGE} --sub-format vtt --no-warnings`;
    if (fs.existsSync(COOKIES_FILE)) {
      cmd += ` --cookies "${COOKIES_FILE}"`;
    }
    cmd += ` -o "${path.join(tmpDir, "%(id)s")}" "${url}"`;
    execSync(cmd, { encoding: "utf-8", stdio: "pipe" });

    const vttFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".vtt"));
    if (vttFiles.length === 0) return null;

    const raw = fs.readFileSync(path.join(tmpDir, vttFiles[0]), "utf-8");
    const lines = [];
    for (const line of raw.split("\n")) {
      if (line.includes("-->") || line.startsWith("WEBVTT") || /^\d+$/.test(line.trim())) {
        continue;
      }
      const cleaned = line.replace(/<[^>]+>/g, "").trim();
      if (cleaned) lines.push(cleaned);
    }
    // Deduplicate consecutive identical lines
    const deduped = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);
    const text = deduped.join(" ").replace(/\s+/g, " ").trim();
    return text || null;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function fetchTranscriptApi(videoId) {
  try {
    const { YoutubeTranscript } = await import("youtube-transcript");
    const items = await YoutubeTranscript.fetchTranscript(videoId, { lang: LANGUAGE });
    const text = items
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text || null;
  } catch (err) {
    const msg = String(err);
    if (msg.includes("blocking") || msg.includes("IPBlocked") || msg.includes("RequestBlocked")) {
      throw new IPBlockedError(msg);
    }
    if (msg.includes("disabled") || msg.includes("Disabled")) {
      console.log(`  [SKIP] Transcripts disabled for ${videoId}`);
      return null;
    }
    if (msg.includes("No transcript") || msg.includes("not find")) {
      console.log(`  [SKIP] No ${LANGUAGE} transcript found for ${videoId}`);
      return null;
    }
    console.log(`  [ERROR] ${videoId}: ${err}`);
    return null;
  }
}

class IPBlockedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "IPBlockedError";
  }
}

function videoAlreadyScraped(videoId, outputPath) {
  if (!fs.existsSync(outputPath)) return false;
  return fs.readdirSync(outputPath).some((f) => f.includes(videoId));
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function randomDelay() {
  const [min, max] = DELAY_BETWEEN_REQUESTS;
  return min + Math.random() * (max - min);
}

async function main() {
  const playlistUrl = process.argv[2];
  if (!playlistUrl) {
    console.log("Usage: node fetch_playlist.js <YOUTUBE_PLAYLIST_URL>");
    console.log(
      "Example: node fetch_playlist.js https://www.youtube.com/playlist?list=PLXpJDlotJP_AbQDmrca2t7TP58KxlFQrq"
    );
    process.exit(1);
  }

  const outputPath = path.resolve(OUTPUT_DIR);
  if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath, { recursive: true });

  const videos = getPlaylistVideos(playlistUrl);
  if (videos.length === 0) {
    console.log("No videos found. Exiting.");
    return;
  }

  let saved = 0;
  let skippedExisting = 0;
  let skippedNoTranscript = 0;
  let consecutiveBlocks = 0;

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const videoId = video.id || (video.url || "").split("v=").pop();
    const title = video.title || videoId;

    console.log(`\n[${i + 1}/${videos.length}] ${title}`);

    // Skip if already scraped
    if (videoAlreadyScraped(videoId, outputPath)) {
      console.log("  [EXISTS] Already scraped, skipping.");
      skippedExisting++;
      continue;
    }

    // Get metadata
    let duration = video.duration || null;
    let uploadDate = video.upload_date || null;
    if (uploadDate && uploadDate.length === 8 && !uploadDate.includes("-")) {
      uploadDate = `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
    }

    if (duration === null || uploadDate === null) {
      const meta = getVideoMetadata(videoId);
      if (duration === null) duration = meta.duration;
      if (uploadDate === null) uploadDate = meta.uploadDate;
    }

    // Fall back to today's date if upload date is unavailable
    if (!uploadDate) {
      const now = new Date();
      uploadDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }

    // Build filename
    const safeTitle = sanitizeFilename(title);
    const filename = path.join(outputPath, `${safeTitle} [${videoId}] ${uploadDate}.txt`);

    // Try yt-dlp first, then API fallback
    let transcript = fetchTranscriptYtdlp(videoId);
    if (transcript === null) {
      try {
        transcript = await fetchTranscriptApi(videoId);
      } catch (err) {
        if (err instanceof IPBlockedError) {
          consecutiveBlocks++;
          console.log(`  [BLOCKED] IP blocked (${consecutiveBlocks}/${MAX_CONSECUTIVE_BLOCKS})`);
          if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
            console.log("\n*** YouTube has blocked this IP. Stopping. ***");
            break;
          }
          skippedNoTranscript++;
          continue;
        }
        throw err;
      }
    }

    if (transcript === null) {
      console.log("  [SKIP] No transcript available");
      skippedNoTranscript++;
      continue;
    }

    consecutiveBlocks = 0;

    const content = [
      `Title: ${title}`,
      `Video ID: ${videoId}`,
      `URL: https://www.youtube.com/watch?v=${videoId}`,
      `Published: ${uploadDate || "unknown"}`,
      `Duration: ${duration}s`,
      "-".repeat(60),
      "",
      transcript,
    ].join("\n");

    fs.writeFileSync(filename, content, "utf-8");
    console.log(`  [SAVED] ${path.basename(filename)}`);
    saved++;

    // Polite delay between requests
    if (i < videos.length - 1) {
      const delay = randomDelay();
      console.log(`  Waiting ${Math.round(delay)}s...`);
      await sleep(delay);
    }
  }

  console.log("\n--- Done ---");
  console.log(`Saved:               ${saved}`);
  console.log(`Already existed:     ${skippedExisting}`);
  console.log(`No transcript:       ${skippedNoTranscript}`);
  console.log(`Output folder: ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
