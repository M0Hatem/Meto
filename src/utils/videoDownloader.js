const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Ensure temp directory exists
const tempDir = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

/**
 * Execute a command and return a Promise.
 */
function runCommand(command, maxBuffer = 1024 * 1024 * 10) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Fetches metadata of a Facebook video using yt-dlp.
 * @param {string} url - The Facebook video/reel URL.
 * @returns {Promise<object>} The parsed metadata.
 */
async function getVideoMetadata(url) {
  // Use --dump-json to get full metadata without downloading
  const cmd = `yt-dlp --dump-json "${url}"`;
  const { stdout } = await runCommand(cmd);
  return JSON.parse(stdout);
}

/**
 * Formats seconds into a HH:MM:SS or MM:SS string.
 */
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Downloads a video using yt-dlp.
 * Checks the size, selects format, downloads, and returns details.
 * @param {string} url - The Facebook video/reel URL.
 * @param {number} maxFileSizeMB - The maximum file size in MB.
 * @returns {Promise<object>} Info containing filePath, title, duration, thumbnail, and cleanUp.
 */
async function downloadVideo(url, maxFileSizeMB = 25) {
  const maxSizeBytes = maxFileSizeMB * 1024 * 1024;
  let metadata = null;
  
  try {
    metadata = await getVideoMetadata(url);
  } catch (err) {
    console.error('Error fetching metadata (will attempt download anyway):', err.message);
  }

  const title = metadata?.title || metadata?.description?.substring(0, 100) || 'Facebook Video';
  const duration = metadata?.duration ? formatDuration(metadata.duration) : 'Unknown';
  const thumbnail = metadata?.thumbnail || null;
  const originalUrl = metadata?.webpage_url || url;

  // Generate unique output filename
  const fileId = crypto.randomBytes(8).toString('hex');
  const outPathPattern = path.join(tempDir, `meto_${fileId}.%(ext)s`);

  // Build the download command.
  // We prefer mp4 files, merge audio and video, and keep the size under maxSizeBytes if possible.
  // Note: yt-dlp --max-filesize option stops downloading if files are too big.
  // We specify target format for best quality and compatibility.
  let downloadCmd = `yt-dlp -f "bv[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv+ba/b" --merge-output-format mp4 --max-filesize "${maxFileSizeMB}M" -o "${outPathPattern}" "${url}"`;

  console.log(`Running yt-dlp command: ${downloadCmd}`);
  await runCommand(downloadCmd);

  // Find the actual downloaded file since it might be merged into .mp4
  const files = fs.readdirSync(tempDir);
  const downloadedFile = files.find(file => file.startsWith(`meto_${fileId}`));

  if (!downloadedFile) {
    throw new Error('Downloaded file not found. It might have exceeded the maximum file size limit or failed to download.');
  }

  const fullPath = path.join(tempDir, downloadedFile);
  const fileStats = fs.statSync(fullPath);

  if (fileStats.size > maxSizeBytes) {
    // Delete file if it somehow exceeded the limit
    fs.unlinkSync(fullPath);
    throw new Error(`The video is too large (${(fileStats.size / (1024 * 1024)).toFixed(1)}MB), exceeding the maximum allowed size of ${maxFileSizeMB}MB.`);
  }

  return {
    filePath: fullPath,
    title,
    duration,
    thumbnail,
    url: originalUrl,
    fileSizeMB: (fileStats.size / (1024 * 1024)).toFixed(1),
    cleanUp: () => {
      try {
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          console.log(`Successfully cleaned up: ${fullPath}`);
        }
      } catch (err) {
        console.error(`Failed to clean up file ${fullPath}:`, err.message);
      }
    }
  };
}

module.exports = {
  downloadVideo,
  getVideoMetadata
};
