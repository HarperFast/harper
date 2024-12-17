ARG NODE_VERSION=22
FROM docker.io/node:${NODE_VERSION} AS builder

ARG HARPERDB_TARBALL
ARG HARPERDB_VERSION

#Change node user and group to harperdb
RUN usermod -d /home/harperdb -l harperdb node && \
    groupmod -n harperdb node && \
    rm -rf /home/node

#Copy HarperDB tarball
COPY --chown=harperdb:harperdb ./$HARPERDB_TARBALL /home/harperdb/$HARPERDB_TARBALL

#Create installation directory, .harperdb directory and hdb_boot_properties.file
RUN mkdir -p /home/harperdb/hdb && \
  chown -R harperdb:harperdb /home/harperdb/hdb && \
  mkdir /home/harperdb/.harperdb && \
  touch /home/harperdb/.harperdb/hdb_boot_properties.file && \
  echo 'settings_path = /home/harperdb/hdb/harperdb-config.yaml\ninstall_user = harperdb' > /home/harperdb/.harperdb/hdb_boot_properties.file && \
  chown -R harperdb:harperdb /home/harperdb/.harperdb

#Set the user for the below instructions (respected by RUN, CMD, ENTRYPOINT only)
USER harperdb

#Set the  working directory
WORKDIR /home/harperdb/

#Set npm global directory
ENV NPM_CONFIG_PREFIX=/home/harperdb/.npm-global
ENV PATH=/home/harperdb/.npm-global/bin:$PATH

#Install HarperDB package and clean up tarball
RUN npm install -g $HARPERDB_TARBALL && \
    npm cache clean --force && \
    rm -f $HARPERDB_TARBALL

FROM docker.io/node:${NODE_VERSION}-slim AS runtime
ARG HARPERDB_TARBALL
ARG HARPERDB_VERSION

# metadata for labels
ARG BUILD_DATE
ARG VCS_REF
ARG VCS_TYPE=git

# for use in labels
ENV SUMMARY="HarperDB is a globally-distributed edge application platform."
ENV DESCRIPTION="HarperDB is a globally-distributed edge application platform comprised of an edge database, streaming broker, and user-defined applications delivering near-zero latency, huge cost savings, and a superior developer experience."

# useful metadata
LABEL name="harperdb/harperdb"
LABEL vendor="HarperDB"
LABEL version=${HARPERDB_VERSION}
LABEL release=${HARPERDB_VERSION}
LABEL maintainer="support@harperdb.io"
LABEL summary="${SUMMARY}"
LABEL description="${DESCRIPTION}"
LABEL help="https://docs.harperdb.io/"
LABEL url="https://hub.docker.com/r/harperdb/harperdb"
LABEL usage="https://hub.docker.com/r/harperdb/harperdb"

#Set HarperDB installation parameters
ENV TC_AGREEMENT=yes
ENV ROOTPATH=/home/harperdb/hdb
ENV OPERATIONSAPI_NETWORK_PORT=9925
ENV HDB_ADMIN_USERNAME=HDB_ADMIN
ENV HDB_ADMIN_PASSWORD=password
ENV LOGGING_STDSTREAMS=true

USER root

# Install ps and git
RUN apt-get update && apt-get install -y procps git

# add Licensing files
RUN mkdir /licenses
COPY utility/Docker/licenses /licenses

#Create mount point
VOLUME /home/harperdb/hdb

#Expose HarperDB ports
EXPOSE 9925
EXPOSE 9926
EXPOSE 9932

#Set npm global directory
ENV NPM_CONFIG_PREFIX=/home/harperdb/.npm-global
ENV PATH=/home/harperdb/.npm-global/bin:$PATH

#Change node user and group to harperdb
RUN usermod -d /home/harperdb -l harperdb node && \
    groupmod -n harperdb node && \
    rm -rf /home/node

#Set the user for the below instructions (respected by RUN, CMD, ENTRYPOINT only)
USER harperdb
COPY --from=builder --chown harperdb:harperdb /home/harperdb/ /home/harperdb/

#Set the  working directory
WORKDIR /home/harperdb/

#If no arguments are passed to docker run, execute HarperDB
CMD ["harperdb"]