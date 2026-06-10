const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ─── Discord path detection ───────────────────────────────────

const DISCORD_CLIENTS = [
  { name: 'Discord Stable', folder: 'discord' },
  { name: 'Discord PTB', folder: 'discordptb' },
  { name: 'Discord Canary', folder: 'discordcanary' }
];

function getDiscordPaths() {
  const appData = process.env.APPDATA;
  if (!appData) return [];

  return DISCORD_CLIENTS
    .map(client => ({
      ...client,
      path: path.join(appData, client.folder)
    }))
    .filter(client => fs.existsSync(client.path));
}

// ─── DPAPI decryption via PowerShell ──────────────────────────

/**
 * Decrypt a DPAPI-protected buffer using Windows CryptUnprotectData
 * via a PowerShell child process. No native module dependency needed.
 *
 * @param {Buffer} encryptedBuffer - The DPAPI-encrypted bytes
 * @returns {Buffer} Decrypted bytes
 */
function dpapiDecrypt(encryptedBuffer) {
  const b64Input = encryptedBuffer.toString('base64');

  // PowerShell one-liner: decode base64 → DPAPI Unprotect → return base64
  const psScript = `
    Add-Type -AssemblyName System.Security;
    $encrypted = [Convert]::FromBase64String('${b64Input}');
    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 0);
    [Convert]::ToBase64String($decrypted);
  `.replace(/\r?\n/g, ' ');

  try {
    const result = execSync(
      `powershell -NoProfile -NonInteractive -Command "${psScript}"`,
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();
    return Buffer.from(result, 'base64');
  } catch (err) {
    throw new Error(`DPAPI decryption failed: ${err.message}`);
  }
}

// ─── Master key extraction ────────────────────────────────────

/**
 * Read the AES master key from Discord's Local State file.
 * The key is stored as base64, prefixed with "DPAPI" (5 bytes).
 */
function getMasterKey(discordPath) {
  const localStatePath = path.join(discordPath, 'Local State');
  if (!fs.existsSync(localStatePath)) {
    throw new Error(`Local State file not found at: ${localStatePath}`);
  }

  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encryptedKeyB64 = localState?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) {
    throw new Error('Could not find os_crypt.encrypted_key in Local State');
  }

  const encryptedKey = Buffer.from(encryptedKeyB64, 'base64');

  // Strip the "DPAPI" prefix (first 5 bytes)
  const dpapiBuf = encryptedKey.slice(5);

  return dpapiDecrypt(dpapiBuf);
}

// ─── Token decryption ─────────────────────────────────────────

/**
 * Decrypt a v10/v20 encrypted token using AES-256-GCM.
 * Format: "v10" or "v20" (3 bytes) + nonce (12 bytes) + ciphertext + auth tag (16 bytes)
 */
function decryptToken(encryptedTokenBuffer, masterKey) {
  // Nonce: bytes 3..15 (12 bytes)
  const nonce = encryptedTokenBuffer.slice(3, 15);
  // Ciphertext + auth tag: bytes 15..end
  const ciphertextWithTag = encryptedTokenBuffer.slice(15);
  // Auth tag is the last 16 bytes
  const authTag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
  // Actual ciphertext
  const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, null, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// ─── LevelDB scanning ────────────────────────────────────────

/**
 * Scan LevelDB files for encrypted token patterns and decrypt them.
 */
function extractTokenFromPath(discordPath) {
  const masterKey = getMasterKey(discordPath);
  const leveldbPath = path.join(discordPath, 'Local Storage', 'leveldb');

  if (!fs.existsSync(leveldbPath)) {
    throw new Error(`LevelDB path not found: ${leveldbPath}`);
  }

  const files = fs.readdirSync(leveldbPath)
    .filter(f => f.endsWith('.ldb') || f.endsWith('.log'));

  // Pattern for encrypted tokens: dQw4w9WgXcQ:base64_encoded_encrypted_token (handles both quoted and unquoted formats)
  const tokenPattern = /dQw4w9WgXcQ:\"?([^\s\"'\\]+)\"?/g;

  for (const file of files) {
    try {
      const filePath = path.join(leveldbPath, file);
      const content = fs.readFileSync(filePath, 'utf8');

      let match;
      while ((match = tokenPattern.exec(content)) !== null) {
        try {
          const encryptedTokenB64 = match[1];
          const encryptedToken = Buffer.from(encryptedTokenB64, 'base64');

          // Check for v10/v20 prefix
          const prefix = encryptedToken.slice(0, 3).toString('utf8');
          if (prefix === 'v10' || prefix === 'v20') {
            const token = decryptToken(encryptedToken, masterKey);
            // Basic token format validation (3 base64 sections separated by dots)
            if (token && token.split('.').length === 3) {
              return token;
            }
          }
        } catch {
          // This particular match failed to decrypt — try next match
          continue;
        }
      }
    } catch {
      // Could not read this file — try next
      continue;
    }
  }

  throw new Error('No valid token found in LevelDB files.');
}

// ─── Electron window ──────────────────────────────────────────

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 450,
    height: 340,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('renderer.html');
}

// ─── IPC handlers ─────────────────────────────────────────────

ipcMain.handle('detect-clients', () => {
  return getDiscordPaths().map(c => ({ name: c.name, path: c.path }));
});

ipcMain.handle('extract-token', async (_event, clientFolder) => {
  try {
    const clients = getDiscordPaths();
    const target = clientFolder
      ? clients.find(c => c.folder === clientFolder || c.path === clientFolder)
      : clients[0]; // Default to first detected client

    if (!target) {
      return { success: false, error: 'No Discord installation detected.' };
    }

    const token = extractTokenFromPath(target.path);
    return { success: true, token, client: target.name };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('copy-to-clipboard', (_event, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('close-app', () => {
  app.quit();
});

// ─── App lifecycle ────────────────────────────────────────────

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
