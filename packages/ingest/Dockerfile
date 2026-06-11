# Ingest + mod dashboard, containerized for the zero-credential demo
# (docker-compose.demo.yml). On a real deployment the ingest usually runs on
# the host instead (`npm run live` in packages/ingest) so it can read .env.
#
# Build context is ./packages (see docker-compose.demo.yml) because the admin
# server serves ../../dashboard/index.html relative to ingest/src/.
FROM node:22-bookworm-slim

# the ingest runs on Node built-ins — no npm install step at all
COPY ingest /app/ingest
COPY dashboard /app/dashboard

# bans/automations/audit persistence lands in ./state (ephemeral in the demo)
RUN mkdir -p /app/ingest/state && chown node /app/ingest/state

WORKDIR /app/ingest
USER node
CMD ["node", "src/index.js"]
