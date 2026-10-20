# Origin site: built with VitePress, served by Caddy on port 80.
# Build from the repository root: docker build -f docs/Dockerfile -t origin-site .
FROM node:24-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm docs:build

FROM caddy:2-alpine
COPY docs/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/docs/.vitepress/dist /srv
EXPOSE 80
