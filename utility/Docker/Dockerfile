FROM registry.access.redhat.com/ubi9/nodejs-18:latest as builder

ARG HARPERDB_TARBALL
ARG HARPERDB_VERSION

# for install only
USER 0

# Change UID and create symlink for compatibility
#   we will do another chown in a few steps
RUN usermod -u 1000 default && \
    ln -s ${HOME} /home/harperdb && \
    chmod -R u=rwx /home/harperdb

#Copy HarperDB tarball
COPY $HARPERDB_TARBALL .

#Create installation directory, .harperdb directory and hdb_boot_properties.file
RUN mkdir -p /home/harperdb/hdb && \
    mkdir /home/harperdb/.harperdb && \
    touch /home/harperdb/.harperdb/hdb_boot_properties.file && \
    echo $'settings_path = /home/harperdb/hdb/harperdb-config.yaml\ninstall_user = default' > /home/harperdb/.harperdb/hdb_boot_properties.file

# fix permissions -- requires root group
RUN chown -R 1000:0 /home/harperdb /home/harperdb/.harperdb /home/harperdb/hdb

#Set the user for the below instructions (respected by RUN, CMD, ENTRYPOINT only)
USER 1000

#Set the  working directory for the below instructions
WORKDIR /home/harperdb/

#Install HarperDB package and clean up tarball
RUN npm install $HARPERDB_TARBALL && \
    npm cache clean --force  && \
    rm -f $HARPERDB_TARBALL

# Runtime stage
FROM registry.access.redhat.com/ubi9/nodejs-18-minimal:latest as runtime
COPY --from=builder $HOME $HOME
COPY --from=builder /etc/passwd /etc/passwd

# metadata for labels
ARG HARPERDB_VERSION
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

# pull from gha build
LABEL build-date="${BUILD_DATE}"
LABEL vcs-ref="${VCS_REF}"
LABEL vcs-type="${VCS_TYPE}"

# inherited labels we need to overwrite
LABEL io.k8s.description="${DESCRIPTION}"
LABEL io.k8s.display-name="HarperDB"
LABEL io.openshift.expose-services="9925:HTTP,9926:HTTP,9932:TCP"
LABEL io.openshift.tags="harperdb"
LABEL com.redhat.component="harperdb-container"

# redhat labels we are allowing throug (except dev-mode.port)
LABEL com.redhat.dev-mode.port="DEBUG_PORT:NA"
# LABEL com.redhat.deployments-dir=""
# LABEL com.redhat.dev-mode=""
# LABEL com.redhat.license_terms=""

# labels we don't want
LABEL io.buildah.version=""
LABEL io.buildpacks.stack.id=""
LABEL io.openshift.s2i.scripts-url=""
LABEL io.s2i.scripts-url=""

#Set HarperDB installation parameters
ENV TC_AGREEMENT=yes
ENV ROOTPATH=/home/harperdb/hdb
ENV OPERATIONSAPI_NETWORK_PORT=9925
ENV HDB_ADMIN_USERNAME=HDB_ADMIN
ENV HDB_ADMIN_PASSWORD=password
ENV LOGGING_STDSTREAMS=true

USER 0

# re-create symlink for compatibility
# install deps
# RHCC Licensing files
RUN ln -sf ${HOME} /home/harperdb && chmod -R u=rwx /home/harperdb && \
    microdnf install --assumeyes --nodocs --refresh hostname git procps && microdnf clean all && \
    mkdir /licenses

COPY utility/Docker/licenses/* /licenses/.

#Create mount point
VOLUME /home/harperdb/hdb

#Expose HarperDB ports
EXPOSE 9925
EXPOSE 9926
EXPOSE 9932

#Set the user for the below instructions (respected by RUN, CMD, ENTRYPOINT only)
USER 1000

#If no arguments are passed to docker run, execute HarperDB
CMD ["harperdb"]