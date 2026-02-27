"""
YouTube Playlist Transcript Fetcher
------------------------------------
Fetches transcripts for all videos in a YouTube playlist
and saves them as clean .txt files. Skips already-scraped videos.

Usage:
    python fetch_playlist.py <PLAYLIST_URL>

Requirements:
    pip install yt-dlp youtube-transcript-api
"""

import os
import re
import sys
import json
import time
import random
import subprocess
import tempfile
import glob as _glob
from pathlib import Path
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound


# --- CONFIG ---
OUTPUT_DIR = "transcripts"
MIN_DURATION_SECONDS = 180
LANGUAGE = "en"
DELAY_BETWEEN_REQUESTS = (3, 8)
COOKIES_FILE = "cookies.txt"
MAX_CONSECUTIVE_BLOCKS = 3
# --------------


def sanitize_filename(name: str) -> str:
    return re.sub(r'[\\/*?:"<>|]', "", name).strip()


def get_playlist_videos(playlist_url: str) -> list[dict]:
    """Use yt-dlp to list all videos in the playlist with metadata."""
    print(f"Fetching video list from: {playlist_url}")
    result = subprocess.run(
        [
            sys.executable, "-m", "yt_dlp",
            "--flat-playlist",
            "--dump-single-json",
            "--no-warnings",
            playlist_url,
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"Error fetching playlist: {result.stderr}")
        return []

    data = json.loads(result.stdout)
    print(f"Playlist: {data.get('title', 'unknown')}")
    entries = data.get("entries", [])
    print(f"Found {len(entries)} videos.")
    return entries


def get_video_metadata(video_id: str) -> dict:
    result = subprocess.run(
        [
            sys.executable, "-m", "yt_dlp",
            "--no-warnings",
            "--print", "%(duration)s\n%(upload_date)s",
            f"https://www.youtube.com/watch?v={video_id}",
        ],
        capture_output=True,
        text=True,
    )
    lines = result.stdout.strip().splitlines()
    meta = {"duration": None, "upload_date": None}
    if len(lines) >= 1:
        try:
            meta["duration"] = int(lines[0])
        except (ValueError, AttributeError):
            pass
    if len(lines) >= 2 and lines[1] and lines[1] != "NA" and len(lines[1]) == 8:
        raw = lines[1]
        meta["upload_date"] = f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"
    return meta


def fetch_transcript_ytdlp(video_id: str) -> str | None:
    url = f"https://www.youtube.com/watch?v={video_id}"
    cookies_path = Path(COOKIES_FILE)
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--write-auto-subs", "--skip-download",
        "--sub-lang", LANGUAGE,
        "--sub-format", "vtt",
        "--no-warnings",
    ]
    if cookies_path.exists():
        cmd += ["--cookies", str(cookies_path)]
    with tempfile.TemporaryDirectory() as tmpdir:
        result = subprocess.run(
            cmd + ["-o", f"{tmpdir}/%(id)s", url],
            capture_output=True, text=True,
        )
        vtt_files = _glob.glob(f"{tmpdir}/*.vtt")
        if not vtt_files:
            return None
        with open(vtt_files[0], encoding="utf-8") as f:
            raw = f.read()
        lines = []
        for line in raw.splitlines():
            if "-->" in line or line.startswith("WEBVTT") or line.strip().isdigit():
                continue
            cleaned = re.sub(r"<[^>]+>", "", line).strip()
            if cleaned:
                lines.append(cleaned)
        deduped = [lines[i] for i in range(len(lines)) if i == 0 or lines[i] != lines[i-1]]
        text = " ".join(deduped)
        text = re.sub(r"\s+", " ", text).strip()
        return text if text else None


class IPBlockedError(Exception):
    pass


def fetch_transcript_api(video_id: str) -> str | None:
    try:
        api = YouTubeTranscriptApi()
        fetched = api.fetch(video_id, languages=[LANGUAGE])
        text = " ".join(snippet.text for snippet in fetched)
        text = re.sub(r"\s+", " ", text).strip()
        return text
    except TranscriptsDisabled:
        print(f"  [SKIP] Transcripts disabled for {video_id}")
        return None
    except NoTranscriptFound:
        print(f"  [SKIP] No {LANGUAGE} transcript found for {video_id}")
        return None
    except Exception as e:
        msg = str(e)
        if "blocking requests" in msg or "IPBlocked" in msg or "RequestBlocked" in msg:
            raise IPBlockedError(msg)
        print(f"  [ERROR] {video_id}: {e}")
        return None


def video_already_scraped(video_id: str, output_path: Path) -> bool:
    """Check if any file in the output dir contains this video ID."""
    for f in output_path.iterdir():
        if video_id in f.name:
            return True
    return False


def main():
    if len(sys.argv) < 2:
        print("Usage: python fetch_playlist.py <YOUTUBE_PLAYLIST_URL>")
        print("Example: python fetch_playlist.py https://www.youtube.com/playlist?list=PLXpJDlotJP_AbQDmrca2t7TP58KxlFQrq")
        sys.exit(1)

    playlist_url = sys.argv[1]

    output_path = Path(OUTPUT_DIR)
    output_path.mkdir(exist_ok=True)

    videos = get_playlist_videos(playlist_url)
    if not videos:
        print("No videos found. Exiting.")
        return

    saved = 0
    skipped_existing = 0
    skipped_no_transcript = 0
    consecutive_blocks = 0

    for i, video in enumerate(videos, 1):
        video_id = video.get("id") or video.get("url", "").split("v=")[-1]
        title = video.get("title") or video_id

        print(f"\n[{i}/{len(videos)}] {title}")

        # Skip if already scraped
        if video_already_scraped(video_id, output_path):
            print(f"  [EXISTS] Already scraped, skipping.")
            skipped_existing += 1
            continue

        # Get metadata
        duration = video.get("duration")
        upload_date = video.get("upload_date")
        if upload_date and len(upload_date) == 8 and "-" not in upload_date:
            upload_date = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}"

        if duration is None or upload_date is None:
            meta = get_video_metadata(video_id)
            if duration is None:
                duration = meta["duration"]
            if upload_date is None:
                upload_date = meta["upload_date"]

        # Build filename and save
        safe_title = sanitize_filename(title)
        date_suffix = f" {upload_date}" if upload_date else ""
        filename = output_path / f"{safe_title} [{video_id}]{date_suffix}.txt"

        # Try yt-dlp first, then API fallback
        transcript = fetch_transcript_ytdlp(video_id)
        if transcript is None:
            try:
                transcript = fetch_transcript_api(video_id)
            except IPBlockedError:
                consecutive_blocks += 1
                print(f"  [BLOCKED] IP blocked ({consecutive_blocks}/{MAX_CONSECUTIVE_BLOCKS})")
                if consecutive_blocks >= MAX_CONSECUTIVE_BLOCKS:
                    print(f"\n*** YouTube has blocked this IP. Stopping. ***")
                    break
                skipped_no_transcript += 1
                continue

        if transcript is None:
            print(f"  [SKIP] No transcript available")
            skipped_no_transcript += 1
            continue

        consecutive_blocks = 0

        with open(filename, "w", encoding="utf-8") as f:
            f.write(f"Title: {title}\n")
            f.write(f"Video ID: {video_id}\n")
            f.write(f"URL: https://www.youtube.com/watch?v={video_id}\n")
            f.write(f"Published: {upload_date or 'unknown'}\n")
            f.write(f"Duration: {duration}s\n")
            f.write("-" * 60 + "\n\n")
            f.write(transcript)

        print(f"  [SAVED] {filename.name}")
        saved += 1

        # Polite delay between requests
        if i < len(videos):
            delay = random.uniform(*DELAY_BETWEEN_REQUESTS)
            print(f"  Waiting {delay:.0f}s...")
            time.sleep(delay)

    print(f"\n--- Done ---")
    print(f"Saved:               {saved}")
    print(f"Already existed:     {skipped_existing}")
    print(f"No transcript:       {skipped_no_transcript}")
    print(f"Output folder: {output_path.resolve()}")


if __name__ == "__main__":
    main()
