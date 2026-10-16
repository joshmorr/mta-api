FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS builder
WORKDIR /app
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY . .
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
EXPOSE 3000
CMD ["/app/start.sh"]
