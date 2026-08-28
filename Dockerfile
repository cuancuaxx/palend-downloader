FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Deno untuk kebutuhan ekstraksi YouTube terbaru
RUN curl -fsSL https://deno.land/install.sh | sh

ENV DENO_INSTALL=/root/.deno
ENV PATH="/root/.deno/bin:${PATH}"

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

# Install yt-dlp terbaru + EJS support
RUN python3 -m pip install --break-system-packages --upgrade \
    "yt-dlp[default]"

COPY . .

RUN mkdir -p /app/downloads

EXPOSE 3000

CMD ["npm", "start"]
