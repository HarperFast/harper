ARG NODE_BUILD_VERSION=24
ARG NODE_VERSION=24

FROM docker.io/node:${NODE_BUILD_VERSION} AS build

WORKDIR /usr/src/harper

COPY . .

RUN env NO_USE_GIT=true npm run package

FROM docker.io/node:${NODE_VERSION} AS run

RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

# Change node user to harper
RUN <<-EOF
  mkdir -p /home/harperdb
  usermod -d /home/harperdb -l harperdb node
  groupmod -n harperdb node
  rm -rf /home/node
  chown -R harperdb:harperdb /home/harperdb
EOF

# Create entrypoint that selects runtime via HARPER_RUNTIME env var
COPY <<'EOF' /usr/local/bin/docker-entrypoint.sh
#!/bin/sh
set -e
if [ "$HARPER_RUNTIME" = "bun" ]; then
  exec bun "$(which harper)" "$@"
else
  exec harper "$@"
fi
EOF
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /home/harperdb

USER harperdb

# Install pnpm
RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash

COPY --from=build /usr/src/harper/harper-*.tgz .

# Configure NPM and Bun paths
ENV NPM_CONFIG_PREFIX=/home/harperdb/.npm-global
ENV PATH=/home/harperdb/.npm-global/bin:/home/harperdb/.bun/bin:$PATH

VOLUME /home/harperdb/harper

# The archive carries its locked JavaScript bundle; npm selects native packages for this image.
RUN <<-EOF
  set -e
  npm install --global --ignore-scripts --no-audit --no-fund ./harper-*.tgz
  rm harper-*.tgz
  # @aws-sdk/client-s3 and @aws-sdk/lib-storage are optional peerDependencies (see
  # dependencies.md) so npm consumers who never touch S3 skip their ~18MB, but the
  # official image should keep S3 export/import working out of the box. Installed
  # globally (siblings of harper under lib/node_modules), which is on Node's require
  # walk from harper's own files the same as any other global sibling package. The
  # separate exact root pins keep their entry-point versions fixed; their ranged
  # transitives (e.g. @smithy/*) still re-resolve at build time --
  # .github/workflows/docker-smoke.yml's "S3 SDK resolves from harper's installed
  # path" step is what actually proves this resolves in the built image. `-g` keeps
  # this independent of harper's own package.json.
  npm install -g --ignore-scripts --no-audit --no-fund @aws-sdk/client-s3@3.1116.0 @aws-sdk/lib-storage@3.1116.0
  npm cache clean --force
  mkdir -p /home/harperdb/harper
  chown harperdb:harperdb /home/harperdb/harper
EOF

# Harper config parameters
ENV HDB_ADMIN_USERNAME=admin
ENV HDB_ADMIN_PASSWORD=password
ENV ROOTPATH=/home/harperdb/harper
ENV TC_AGREEMENT=yes
ENV OPERATIONSAPI_NETWORK_PORT=9925
ENV LOGGING_STDSTREAMS=true
ENV NODE_HOSTNAME=localhost
ENV DEFAULTS_MODE=prod

EXPOSE 9925
EXPOSE 9926
EXPOSE 9932
EXPOSE 9933

# Harper must not be PID 1 so its restart watchdog can force a wedged teardown to exit.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/docker-entrypoint.sh"]

CMD ["run"]
