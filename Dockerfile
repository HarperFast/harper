ARG NODE_BUILD_VERSION=24
ARG NODE_VERSION=24

FROM docker.io/node:${NODE_BUILD_VERSION} AS build

WORKDIR /usr/src/harper

COPY . .

RUN env NO_USE_GIT=true npm run package

FROM docker.io/node:${NODE_VERSION} AS run

# Change node user to harper
RUN <<-EOF
  mkdir -p /home/harperdb
  usermod -d /home/harperdb -l harperdb node
  groupmod -n harperdb node
  rm -rf /home/node
  chown -R harperdb:harperdb /home/harperdb
EOF

# Create entrypoint that selects runtime via HARPER_RUNTIME env var
RUN <<-'EOF' > /usr/local/bin/docker-entrypoint.sh
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

# Install Harper globally
RUN <<-EOF
  npm install --ignore-scripts --global harper-*.tgz
  rm harper-*.tgz
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

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD ["run"]
