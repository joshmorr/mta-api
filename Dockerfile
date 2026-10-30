FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS builder
WORKDIR /app
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY . .
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
EXPOSE 3000
CMD ["/app/start.sh"]
