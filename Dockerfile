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

# Install Harper globally
RUN <<-EOF
  npm install --ignore-scripts --global harper-*.tgz
  rm harper-*.tgz
  # alasql declares an optional dependency on react-native-fs, which peer-depends on
  # react-native. npm auto-installs peer deps, so a plain install drags ~130M of
  # react-native/metro/hermes/react-devtools in here. alasql only requires
  # react-native-fs behind an isReactNative guard, so none of it can execute under Node.
  # The root override in package.json cannot reach this install: npm honours overrides
  # only for the root project, and ignores a published npm-shrinkwrap.json when
  # installing from a tarball. So the tree gets pruned after the fact.
  # The `cd &&` guard means a bad path prunes nothing rather than deleting the wrong tree.
  ( cd /home/harperdb/.npm-global/lib/node_modules/harper/node_modules && rm -rf \
      react react-devtools-core react-is react-native react-native-fs react-refresh \
      scheduler hermes-compiler hermes-estree hermes-parser metro metro-* ob1 \
      babel-plugin-syntax-hermes-parser @react-native )
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
