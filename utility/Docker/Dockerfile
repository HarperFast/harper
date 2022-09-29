ARG NODE_VERSION
FROM node:$NODE_VERSION-bullseye-slim
ARG HARPERDB_TARBALL

#Expose HarperDB port
EXPOSE 9925

#Install prerequisites
RUN apt-get update && apt-get install -y tini=0.19.0-1

#Change node user and group to harperdb
RUN usermod -d /home/harperdb -l harperdb node && \
    groupmod -n harperdb node && \
    rm -rf /home/node

#Copy HarperDB tarball
COPY --chown=harperdb:harperdb ./$HARPERDB_TARBALL /home/harperdb/

#Create installation directory, .harperdb directory and hdb_boot_properties.file
RUN mkdir -p /home/harperdb/hdb && \
  chown -R harperdb:harperdb /home/harperdb/hdb && \
  mkdir /home/harperdb/.harperdb && \
  touch /home/harperdb/.harperdb/hdb_boot_properties.file && \
  echo 'settings_path = /opt/harperdb/hdb/harperdb.conf\ninstall_user = harperdb' > /home/harperdb/.harperdb/hdb_boot_properties.file && \
  chown -R harperdb:harperdb /home/harperdb/.harperdb

#Create mount point
VOLUME /home/harperdb/hdb

#Set npm global directory
ENV NPM_CONFIG_PREFIX=/home/harperdb/.npm-global
ENV PATH=/home/harperdb/.npm-global/bin:$PATH

#Set HarperDB installation parameters
ENV TC_AGREEMENT=yes
ENV ROOTPATH=/home/harperdb/hdb
ENV OPERATIONSAPI_NETWORK_PORT=9925
ENV HDB_ADMIN_USERNAME=HDB_ADMIN
ENV HDB_ADMIN_PASSWORD=password
ENV LOGGING_STDSTREAMS=true
ENV OPERATIONSAPI_FOREGROUND=true

#Set the user for the below instructions (respected by RUN, CMD, ENTRYPOINT only)
USER harperdb

#Set the  working directory for the below instructions
WORKDIR /home/harperdb/

#Install HarperDB and clean up
RUN npm install -g $HARPERDB_TARBALL && \
    npm cache clean --force && \
    rm -f $HARPERDB_TARBALL

#Execute Tini when container starts
ENTRYPOINT ["tini","--"]

#If no arguments are passed to docker run, Tini will execute HarperDB
CMD ["harperdb"]