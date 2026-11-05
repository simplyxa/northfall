# Northfall — сервер для Fly.io
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY netlify ./netlify
COPY public ./public
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
