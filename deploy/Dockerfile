# Builds maka-cloud from this checkout. Build context: the repository root.
#
#   docker build -f deploy/Dockerfile --target server -t maka-cloud:local .
#   docker build -f deploy/Dockerfile --target proxy  -t maka-cloud-proxy:local .
#
# `server` runs `maka-cloud <command>` (default: start) as the unprivileged `node` user, with its
# data in /data and its backups in /backups. `proxy` is Caddy with the built web app in /srv/web.
# deploy/compose.yaml builds and runs both.

FROM node:24-slim AS build
WORKDIR /app
# The context is an allowlist (.dockerignore); the copy names what the build reads, so a file the
# context lets through that this does not name is still not in an image.
COPY package.json package-lock.json tsconfig.base.json tsconfig.lib.json ./
COPY packages ./packages
COPY scripts/sync-model-metadata.mjs ./scripts/
COPY scripts/model-metadata ./scripts/model-metadata

# Only what the server needs: the host package, the workspaces it depends on, and the root.
RUN npm ci -w @maka-cloud/host --include-workspace-root --ignore-scripts --no-audit --no-fund

# The order is the one the root `build` script uses, without what the server does not import.
RUN set -eu; \
    for workspace in \
      @maka/core @maka/storage @maka/runtime \
      @maka-cloud/orchestrator @maka-cloud/modes @maka-cloud/memory @maka-cloud/server \
      @maka-cloud/instabox @maka-cloud/runners @maka-cloud/boxes @maka-cloud/conductor-checks \
      @maka-cloud/conductor @maka-cloud/playbooks @maka-cloud/supervisor \
      @maka-cloud/gateway @maka-cloud/duties @maka-cloud/host; do \
      npm --workspace "$workspace" run build; \
    done

# The web app is not a root workspace: its toolchain pins differ from the root's.
RUN npm --prefix packages/cloud-web ci --workspaces=false --ignore-scripts --no-audit --no-fund \
 && npm --prefix packages/cloud-web run build \
 && mv packages/cloud-web/dist /web-dist \
 && rm -rf packages/cloud-web/node_modules

FROM node:24-slim AS server
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# Named volumes take their owner from these directories the first time they are mounted.
RUN install -d -o node -g node -m 700 /data /backups
ENV MAKA_CLOUD_DATA_DIR=/data MAKA_CLOUD_BACKUP_DIR=/backups
USER node
EXPOSE 8080 8081 8082
ENTRYPOINT ["node", "packages/cloud-host/dist/cli.js"]
CMD ["start"]

# Only the go-live rehearsal uses this one (deploy/rehearsal/compose.yaml): the stand-in for a sandbox
# machine. A real machine has an agent account the CLIs run as, a group it shares with the sandbox
# user, passwordless sudo for the sandbox user and `getcap` (the box check lists file capabilities and
# refuses a box that cannot); this one is made like that, from the server's
# own image, so the server's agent-account code runs against two real accounts. It is not a deployment
# target and no real deployment builds it.
FROM server AS rehearsal-sandbox
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends sudo libcap2-bin git \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd maka-box \
 && useradd --no-create-home --gid maka-box --shell /bin/bash maka-agent \
 && usermod -aG maka-box node \
 && echo 'node ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/rehearsal-node \
 && chmod 440 /etc/sudoers.d/rehearsal-node \
 && chmod 711 /data
USER node

# Only CI uses this one (.github/workflows/fork-deploy-rehearsal.yml, job `real-accounts`): the
# cloud-runners suite and the `coding` suite of cloud-playbooks, built in the `build` stage above, run as root next
# to a second account made like the rehearsal sandbox's (`maka-agent` in `maka-box`, real `sudo`,
# `getcap`, `git`, `pgrep`), on a machine with nothing else on it. A hosted runner cannot do this: it is not
# root for the tests and its own setuid tools and capabilities fail the box check. With
# MAKA_REQUIRE_REAL_ACCOUNTS the tests that need the second account fail instead of skipping, so a
# green job means they ran. Not a deployment target.
FROM build AS real-account-tests
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends sudo libcap2-bin git procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd maka-box \
 && useradd --no-create-home --gid maka-box --shell /bin/bash maka-agent
ENV MAKA_REQUIRE_REAL_ACCOUNTS=1 MAKA_TEST_AGENT_USER=maka-agent MAKA_TEST_AGENT_GROUP=maka-box
WORKDIR /app/packages
COPY deploy/real-account-tests.sh /usr/local/bin/real-account-tests
CMD ["real-account-tests"]

FROM caddy:2-alpine AS proxy
COPY --from=build /web-dist /srv/web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
