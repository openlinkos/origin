# Origin personal hub: `origin serve` in a container. Mount a volume at /data.
#   docker run -d --name origin-hub -p 7077:7077 -v origin-data:/data ghcr.io/openlinkos/origin
#   docker exec origin-hub origin token create laptop
FROM node:24-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-alpine
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_ENV=production ORIGIN_HOME=/data
WORKDIR /app
RUN corepack enable
COPY --from=build /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml /src/.npmrc ./
COPY --from=build /src/packages/core/package.json packages/core/package.json
COPY --from=build /src/packages/core/dist packages/core/dist
COPY --from=build /src/packages/adapters/package.json packages/adapters/package.json
COPY --from=build /src/packages/adapters/dist packages/adapters/dist
COPY --from=build /src/packages/mcp/package.json packages/mcp/package.json
COPY --from=build /src/packages/mcp/dist packages/mcp/dist
COPY --from=build /src/packages/cli/package.json packages/cli/package.json
COPY --from=build /src/packages/cli/dist packages/cli/dist
RUN pnpm install --frozen-lockfile --prod --store-dir /tmp/pnpm-store \
  && rm -rf /tmp/pnpm-store \
  && chmod +x packages/cli/dist/bin.js \
  && ln -s /app/packages/cli/dist/bin.js /usr/local/bin/origin \
  && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7077
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:7077/healthz || exit 1
ENTRYPOINT ["origin"]
CMD ["serve", "--host", "0.0.0.0", "--port", "7077"]
