# Summarize YouTube Playlist

Fetch transcripts and generate detailed bullet-point summaries for all videos in my YouTube playlist that haven't already been scraped.

**Playlist URL:** https://www.youtube.com/playlist?list=PLXpJDlotJP_AbQDmrca2t7TP58KxlFQrq

## Steps

1. **Run the fetch script** to download transcripts for any new (unscraped) videos:
   ```
   cd "c:/Users/nhand/OneDrive/SLT App/Claude Code/Nhan YouTube Playlist Video Summary/App"
   node fetch_playlist.js "https://www.youtube.com/playlist?list=PLXpJDlotJP_AbQDmrca2t7TP58KxlFQrq"
   ```

2. **Identify which videos are new** — compare the saved transcripts against any existing summary files in the `summaries/` folder to determine which videos need summarizing.

3. **Read each new transcript** and generate a detailed bullet-point summary covering:
   - Video title, channel, publish date, duration, and URL
   - All major topics, arguments, and takeaways organized with headers and nested bullets
   - Key quotes or memorable lines when relevant
   - Actionable insights or practical advice mentioned

4. **Save the summaries** to:
   ```
   summaries/Playlist Summaries YYYY-MM-DD.md
   ```
   Use today's date. If a summary file for today already exists, append the new video summaries to it rather than overwriting.

5. **Report back** with a brief highlight of each video summarized.
