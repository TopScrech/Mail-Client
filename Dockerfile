FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.2
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 BODY_SIZE_LIMIT=16777216 DATABASE_PATH=/app/data/mail-otter.sqlite
COPY --from=build /app/build ./build
COPY --from=build /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production && mkdir /app/data && chown bun:bun /app/data
USER bun
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["bun", "build/index.js"]
