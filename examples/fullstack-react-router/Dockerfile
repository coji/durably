# Build from monorepo root:
#   docker build -f examples/fullstack-react-router/Dockerfile -t durably-fullstack .

FROM node:24-alpine AS base
RUN npm install -g pnpm

# Install all dependencies (workspace-aware)
FROM base AS deps
WORKDIR /app
COPY .npmrc pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/durably/package.json ./packages/durably/
COPY packages/durably-react/package.json ./packages/durably-react/
COPY examples/fullstack-react-router/package.json ./examples/fullstack-react-router/
RUN pnpm install --frozen-lockfile

# Build workspace packages and the app
FROM base AS build
WORKDIR /app
COPY --from=deps /app ./
COPY packages/durably/ ./packages/durably/
COPY packages/durably-react/ ./packages/durably-react/
COPY examples/fullstack-react-router/ ./examples/fullstack-react-router/
RUN pnpm --filter @coji/durably build && \
    pnpm --filter @coji/durably-react build && \
    pnpm --filter example-fullstack-react-router build

# Deploy as standalone with production dependencies
FROM base AS deploy
WORKDIR /app
COPY --from=build /app ./
RUN pnpm --filter example-fullstack-react-router --prod deploy /deployed

# Final production image
FROM node:24-alpine
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
COPY --chown=node:node --from=deploy /deployed ./
COPY --chown=node:node --from=build /app/examples/fullstack-react-router/build ./build
USER node
CMD ["./node_modules/.bin/react-router-serve", "./build/server/index.js"]
