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

# Run as non-root so bind-mounted host dirs get the expected ownership
# (uid 1000) instead of root.
RUN useradd -u 1000 -m -s /bin/bash crosspost && \
    chown -R crosspost:crosspost /app
USER crosspost

CMD ["node", "src/server.js"]
