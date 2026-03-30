FROM oven/bun:1-slim AS builder
WORKDIR /app
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY . .
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
EXPOSE 3000
CMD ["/app/start.sh"]
