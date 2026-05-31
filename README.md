# Meto — Facebook Reels & Videos Discord Bot

Meto is a premium Discord bot that automatically detects Facebook Video and Reel links, downloads the video using `yt-dlp`, and re-uploads it as a native attachment. This allows server members to watch Facebook content directly inline in their Discord client without needing to click external links.

---

## 🛠️ Prerequisites

Before you can run Meto, your server/machine needs the following three components installed:

### 1. Node.js
- Ensure you have **Node.js 18.0.0 or higher** installed.
- [Download Node.js for Windows](https://nodejs.org/en/download)

### 2. yt-dlp
`yt-dlp` is a feature-rich command-line audio/video downloader. Meto spawns `yt-dlp` in the background to fetch Facebook videos.
- **Installation via winget (Windows Package Manager):**
  Open PowerShell as Administrator and run:
  ```powershell
  winget install yt-dlp
  ```
- **Manual Installation:**
  Download `yt-dlp.exe` from the [Official Release page](https://github.com/yt-dlp/yt-dlp/releases) and add it to your Windows System PATH.

### 3. FFmpeg
`FFmpeg` is required by `yt-dlp` to merge high-quality video and audio streams into a single `.mp4` container.
- **Installation via winget:**
  Open PowerShell as Administrator and run:
  ```powershell
  winget install Gyan.FFmpeg
  ```
- **Manual Installation:**
  Download FFmpeg from [ffmpeg.org](https://ffmpeg.org/download.html), extract it, and add the `bin/` directory to your Windows System PATH.

*Verify both are installed correctly by running `yt-dlp --version` and `ffmpeg -version` in your terminal.*

---

## 🚀 Getting Started

### Step 1: Install Dependencies
Open your command line in the `Meto` project directory and run:
```bash
npm install
```

### Step 2: Configure Environment Variables
1. Find the `.env` file in the root directory.
2. Replace `replace_this_with_your_actual_bot_token` with your actual Discord Bot Token from the Discord Developer Portal.
3. Optionally adjust `MAX_FILE_SIZE_MB` (default: 25) depending on your server's boost tier.

### Step 3: Run the Bot
- **Development Mode (with auto-restart on code changes):**
  ```bash
  npm run dev
  ```
- **Production Mode:**
  ```bash
  npm run start
  ```

---

## 🤖 How to set up a Discord Bot Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and give it a name (e.g., `Meto`).
3. Navigate to the **Bot** tab on the left sidebar:
   - Click **Add Bot**.
   - Under **Privileged Gateway Intents**, enable **Message Content Intent** (CRITICAL: without this, the bot cannot read messages to detect links).
   - Click **Reset Token** to copy your bot token, and paste it in your `.env` file under `DISCORD_TOKEN`.
4. Navigate to the **OAuth2** tab, then **URL Generator**:
   - Select **Scopes**: `bot`.
   - Select **Bot Permissions**:
     - `Read Messages/View Channels`
     - `Send Messages`
     - `Embed Links`
     - `Attach Files`
     - `Add Reactions`
     - `Manage Messages` (Optional: allows the bot to hide original ugly link previews)
   - Copy the generated URL and open it in a browser to invite the bot to your Discord server!

---

## 📁 File Structure
```
Meto/
├── src/
│   ├── index.js              # Main bot entry point & Discord client setup
│   └── utils/
│       ├── linkDetector.js   # Advanced regex matching for Facebook URLs
│       ├── videoDownloader.js# Controls yt-dlp downloader process & checks size
│       └── embedBuilder.js   # Builds Discord embeds using Discord.js
├── temp/                     # Temporary directory for video files (auto-cleaned)
├── .env                      # Application environment variables (git-ignored)
├── .env.example              # Template for environment variables
├── .gitignore                # Files excluded from git tracking
├── package.json              # Project dependencies & scripts
└── README.md                 # Project instructions
```
