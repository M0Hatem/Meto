# Use lightweight Debian slim image with Node.js
FROM node:22-slim

# Install Python 3, FFmpeg, curl, and certificates (required for yt-dlp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Download the latest yt-dlp binary and make it executable
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

RUN npm ci --only=production

# Bundle app source and config files
COPY src/ ./src/
COPY data/ ./data/
COPY allowed_servers.json* ./

# Create a directory for temporary video files
RUN mkdir -p temp

# Start the bot
CMD [ "node", "src/index.js" ]

