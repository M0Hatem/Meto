# Use lightweight Alpine image with Node.js
FROM node:18-alpine

# Install Python 3, FFmpeg, curl, and certificates (required for yt-dlp)
RUN apk add --no-cache python3 ffmpeg curl ca-certificates

# Download the latest yt-dlp binary and make it executable
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

RUN npm ci --only=production

# Bundle app source
COPY src/ ./src/

# Create a directory for temporary video files
RUN mkdir -p temp

# Start the bot
CMD [ "node", "src/index.js" ]

