# Origin site: built with VitePress, served by unprivileged Nginx on port 8080.
# Build from the repository root: docker build -f docs/Dockerfile -t origin-site .
FROM node:24-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm docs:build

FROM nginxinc/nginx-unprivileged:alpine
COPY docs/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/docs/.vitepress/dist /usr/share/nginx/html
EXPOSE 8080
