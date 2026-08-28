FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p uploads outputs
ENV PORT=3000
EXPOSE 3000
CMD ["npm","start"]
