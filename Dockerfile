FROM oven/bun:1.2-debian AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ─── Production image ──────────────────────────────────────────────────────────
FROM oven/bun:1.2-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/public  ./dist/public
COPY --from=builder /app/src          ./src
COPY --from=builder /app/agents       ./agents
COPY package.json tsconfig.json bunfig.toml ./

# Directories for uploads, tmp processing, and persistent DB
RUN mkdir -p /var/clip-pipeline/uploads /tmp/clips /var/clip-pipeline/db

EXPOSE 3000

CMD ["bun", "src/index.ts"]
