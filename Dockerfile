FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/
COPY public/ public/

RUN mkdir -p /app/data

ENV DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]
