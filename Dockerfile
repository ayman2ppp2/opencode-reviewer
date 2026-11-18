FROM oven/bun:1.3.10-debian
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
USER bun
CMD ["bun", "src/engine-worker.ts"]
