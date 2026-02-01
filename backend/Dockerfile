FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY app.js jackettClient.js qbittorrentClient.js ./
CMD ["node", "app.js"]