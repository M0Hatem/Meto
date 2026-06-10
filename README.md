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

## 📡 Streaming Feature

Meto can stream a blank screen (or video) into a voice channel using a self-bot layer. This makes the bot appear as "Streaming" in the voice channel.

> **⚠️ Warning:** This feature uses a self-bot (a real user account logged in programmatically), which violates Discord's Terms of Service. Use a throwaway/alt account, not your main. Don't stream 24/7.

### Setup

1. **Extract your Discord user token** using the Token Extractor utility:
   ```bash
   cd token-extractor
   npm install
   npm start
   ```
   Click "Extract Token" → "Copy" → paste into your `.env` file.

2. **Add to `.env`:**
   ```env
   USER_TOKEN=your_extracted_user_token_here
   ```

3. **Ensure `ffmpeg` is installed** and on your system PATH (required by the streaming library).

### Commands

| Command | Description |
|---------|-------------|
| `/stream start` | Start a blank stream in the current voice channel |
| `/stream start type:video file:myfile.mp4` | Stream a video file from `streamAssets/` |
| `/stream stop` | Stop the active stream |
| `/stream status` | Check current stream info (type, uptime, channel) |

### Notes
- You must use `/join` first before starting a stream
- Only one stream per server at a time
- The stream auto-stops if the bot leaves the voice channel (`/leave`)
- Only the authorized user can use `/stream`

---

## 📁 File Structure
```
Meto/
├── src/
│   ├── index.js                  # Main bot entry point & Discord client setup
│   ├── handlers/
│   │   ├── commandRegistry.js    # Slash command registration
│   │   ├── interactionHandler.js # Command dispatch
│   │   ├── messageHandler.js     # Facebook link processing
│   │   ├── voiceHandler.js       # Voice channel join/leave/reconnect
│   │   ├── streamHandler.js      # /stream command handler
│   │   └── wakeHandler.js        # /wake loop management
│   ├── stream/
│   │   ├── StreamClient.js       # Self-bot streaming engine
│   │   ├── streamConfig.js       # Per-guild stream configuration
│   │   └── streamAssets/         # Video files for stream video mode
│   └── utils/
│       ├── linkDetector.js       # Facebook URL regex matching
│       ├── videoDownloader.js    # yt-dlp downloader
│       ├── embedBuilder.js       # Discord embed builder
│       └── webhookHandler.js     # Webhook message sender
├── data/                         # Runtime config storage (git-ignored)
├── token-extractor/              # Standalone Electron token extraction utility
│   ├── main.js
│   ├── preload.js
│   ├── renderer.html
│   ├── package.json
│   └── README.md
├── temp/                         # Temporary directory for video files (auto-cleaned)
├── .env                          # Environment variables (git-ignored)
├── .env.example                  # Template for environment variables
├── .gitignore
├── package.json
└── README.md
```

