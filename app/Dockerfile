FROM node:26.10.0-bookworm-slim AS dependencies

WORKDIR /app

# Build sqlite3 for Bookworm instead of relying on a prebuilt binary that may
# target a newer glibc version than the runtime image provides.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm_config_build_from_source=true npm ci --omit=dev && npm cache clean --force

FROM node:26.10.0-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules

COPY --chown=node:node . ./

USER node
EXPOSE 3000

CMD ["npm", "start"]
