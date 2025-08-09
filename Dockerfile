# Multi-stage build (simple)
FROM node:22-slim

# Install system packages needed for headless Chromium (whatsapp-web.js)
# Using packages from packages.txt copied into image.
WORKDIR /app
COPY packages.txt ./
RUN apt-get update \
  && xargs -a packages.txt apt-get install -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Copy app
COPY package.json package-lock.json* ./
RUN npm install --production --no-audit --no-fund
COPY . .

ENV PORT=10000 \
    SESSION_PATH=.session \
    NODE_ENV=production

EXPOSE 10000
CMD ["npm","start"]
