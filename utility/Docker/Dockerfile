FROM ubuntu:20.04
ARG NVM_VERSION
ARG NODE_VERSION
ARG HARPERDB_TARBALL

#Expose HarperDB port
EXPOSE 9925

#Install prerequisites
RUN apt-get update  && apt-get install -y curl g++ make python3 tini

#Create non-root user
RUN adduser --home /home/ubuntu --gecos "" --shell /bin/bash --disabled-password ubuntu

#Copy HarperDB tarball
COPY --chown=ubuntu:ubuntu ./$HARPERDB_TARBALL /home/ubuntu/

#Create installation directory, .harperdb directory and hdb_boot_properties.file
RUN mkdir -p /opt/harperdb/hdb && chown -R ubuntu:ubuntu /opt/harperdb/hdb && \
  mkdir /home/ubuntu/.harperdb && touch /home/ubuntu/.harperdb/hdb_boot_properties.file && \
  echo 'settings_path = /opt/harperdb/hdb/config/settings.js\ninstall_user = ubuntu' > /home/ubuntu/.harperdb/hdb_boot_properties.file && \
  chown -R ubuntu:ubuntu /home/ubuntu/.harperdb

#Set the user for the below instructions
USER ubuntu

#Set HarperDB installation parameters
ENV TC_AGREEMENT=yes
ENV HDB_ROOT=/opt/harperdb/hdb
ENV SERVER_PORT=9925
ENV HDB_ADMIN_USERNAME=HDB_ADMIN
ENV HDB_ADMIN_PASSWORD=password
ENV LOG_TO_STDSTREAMS=true
ENV RUN_IN_FOREGROUND=true

#Install nvm, Node.js, and HarperDB
ENV NVM_DIR=/home/ubuntu/.nvm
ENV PATH=/home/ubuntu/.nvm/versions/node/v$NODE_VERSION/bin:$PATH
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v$NVM_VERSION/install.sh | bash \
    && . $NVM_DIR/nvm.sh \
    && nvm install $NODE_VERSION \
    && cd /home/ubuntu/ \
    && npm install -g $HARPERDB_TARBALL

#Create mount point
VOLUME /opt/harperdb/hdb

#Set the  working directory for the below instructions
WORKDIR /home/ubuntu/

#Execute Tini when container starts
ENTRYPOINT ["tini","--"]

#If no arguments are passed to docker run, Tini will execute HarperDB
CMD ["harperdb"]