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

# Install Harper from the packed tarball, honoring its bundled npm-shrinkwrap.json.
# `npm install --global harper-*.tgz` only reads a shrinkwrap when the REGISTRY packument
# says the package has one (`_hasShrinkwrap`); a local tarball has no packument, so npm
# never learns the shrinkwrap exists and re-resolves every dependency fresh against
# package.json's ranges instead of the pinned tree. Extracting the tarball into a normal
# project directory and running `npm install` there makes npm read npm-shrinkwrap.json
# straight off disk, exactly as it would for any checked-out project, so we replicate
# npm's own global-install layout (lib/node_modules/<pkg> + a bin symlink) by hand instead
# of routing back through the global installer, which would hit the same packument gap.
RUN <<-EOF
  set -e
  pkgDir="$NPM_CONFIG_PREFIX/lib/node_modules/harper"
  mkdir -p "$pkgDir"
  tar -xzf harper-*.tgz --strip-components=1 -C "$pkgDir"
  rm harper-*.tgz
  cd "$pkgDir"
  test -f npm-shrinkwrap.json || { echo "npm-shrinkwrap.json is missing from the packed tarball -- npm install would silently re-resolve everything fresh instead of honoring the pinned tree (see #1960)" >&2; exit 1; }
  npm install --omit=dev --ignore-scripts --no-audit --no-fund
  npm cache clean --force
  mkdir -p "$NPM_CONFIG_PREFIX/bin"
  ln -s ../lib/node_modules/harper/dist/bin/harper.js "$NPM_CONFIG_PREFIX/bin/harper"
  chmod +x "$pkgDir/dist/bin/harper.js"
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
