FROM node:24-bookworm-slim AS build
ARG NODE_BUILD_OPTIONS=""
ENV NODE_OPTIONS=${NODE_BUILD_OPTIONS}
WORKDIR /workspace
RUN npm install -g pnpm@9.15.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages/shared packages/shared
COPY eval eval
RUN pnpm --filter @sufler/api build
RUN pnpm --filter @sufler/api deploy --prod /out
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
