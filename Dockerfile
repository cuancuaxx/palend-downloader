FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=production

RUN apt-get update && \
    apt-get install -y \
    ffmpeg \
    nodejs \
    npm \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

RUN pip install --no-cache-dir \
    -U \
    "yt-dlp[default,curl-cffi]"

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
