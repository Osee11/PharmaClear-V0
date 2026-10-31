FROM node:22-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY serveur_c/serveur.c ./serveur_c/serveur.c
RUN gcc -Wall -Wextra -O2 -pthread -o /serveur ./serveur_c/serveur.c

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    PHARMA_BIND=127.0.0.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
COPY --from=build --chown=node:node /serveur /app/serveur_c/serveur
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/runtime /app/uploads /app/serveur_c/queue \
        /app/serveur_c/done /app/serveur_c/results \
    && chown -R node:node /app/runtime /app/uploads /app/serveur_c

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
