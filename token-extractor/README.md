# Meto Token Extractor

> **⚠️ Private utility — do not distribute.**

A small Electron app that extracts your Discord user token from the local Discord desktop client's storage. The token is needed by the Meto bot's `/stream` feature (self-bot streaming layer).

## Prerequisites

- **Windows** (required — uses Windows DPAPI for token decryption)
- **Discord desktop client** installed (Stable, PTB, or Canary)
- **Node.js 18+**

## Usage

### Development

```bash
cd token-extractor
npm install
npm start
```

### Build portable .exe

```bash
npm run build
```

The output will be in `dist/meto-token-extractor.exe` — a single portable executable, no installer needed.

### Using the extracted token

1. Launch the Token Extractor
2. Click **"Extract Token"**
3. Click **"Copy"** to copy the token to your clipboard
4. Paste it into the Meto bot's `.env` file:
   ```env
   USER_TOKEN=paste_your_token_here
   ```

## How it works

1. Detects installed Discord clients (`%APPDATA%/discord`, `discordptb`, `discordcanary`)
2. Reads the `Local State` file to extract the encrypted master key
3. Decrypts the master key using Windows DPAPI (via a PowerShell child process — no native module dependencies)
4. Scans `Local Storage/leveldb/*.ldb` and `*.log` files for encrypted token patterns
5. Decrypts tokens using AES-256-GCM with the master key

**No data is sent over the network.** Everything happens locally.

## Fallback: Manual extraction

If the automated extraction fails (e.g., Discord changed its storage format):

1. Open Discord desktop
2. Press `Ctrl+Shift+I` to open DevTools
3. Go to **Application** → **Local Storage** → `https://discord.com`
4. Find the `token` key and copy its value (without quotes)

## Security

- This tool reads sensitive credentials from your local machine
- Never share your Discord token with anyone
- Never distribute this tool or its built executable
- Use a throwaway/alt Discord account for self-bot streaming — self-bots violate Discord's Terms of Service
