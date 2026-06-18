#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "=== Pulling latest changes from main branch ==="
git pull origin main

echo "=== Rebuilding Docker image ==="
docker build -t meto-bot .

echo "=== Restarting container ==="
# Stop and remove existing container if they exist
docker stop meto || true
docker rm meto || true

# Run new container
docker run -d --name meto --restart always --env-file .env meto-bot

echo "=== Deployment completed successfully! ==="
docker ps -f name=meto
