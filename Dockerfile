FROM node:22-slim

WORKDIR /app

# git и ripgrep нужны бинарнику Claude Agent SDK
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY bot.js ./

CMD ["node", "bot.js"]
