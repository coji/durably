# Standalone Dockerfile for deploying the fullstack React Router example.
#
# To use this in your own project, copy this directory and replace
# "workspace:*" in package.json with the published version (e.g. "^0.15.0"),
# then run:
#   docker build -t my-app .

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile || npm install

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
COPY --chown=node:node --from=build /app/package.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/build ./build
USER node
CMD ["./node_modules/.bin/react-router-serve", "./build/server/index.js"]
