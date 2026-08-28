FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# Install Python, FFmpeg dan tools dasar
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 \
       python3-pip \
       ffmpeg \
       curl \
       ca-certificates \
       unzip \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN python3 -m pip install --break-system-packages --no-cache-dir -U yt-dlp

COPY package.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/downloads
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["npm", "start"]
