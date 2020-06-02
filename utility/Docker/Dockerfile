FROM node:12.16.2-alpine

#Expose harperdb Default ports
EXPOSE 9925 1111 31283

#aplpine linux default shell is sh.
#installing bash.
RUN apk update && apk upgrade && apk add --no-cache bash && apk add --no-cache g++ && apk add --no-cache make && apk add --no-cache python && apk add --no-cache rsync && apk add --no-cache tini

#RUN apt-get update && apt-get -y upgrade && apt-get install -y rsync
#COPY harperdb INIT script
COPY --chown=node:node ./hdb_docker_init.sh /usr/local/bin/
ADD --chown=node:node ./docs.tar /home/node/
#COPY npm packed source code
#COPY --chown=node:node ./harperdb-2.0.0.tgz /usr/local/bin/

#COPY entrypoint.sh
COPY --chown=node:node ./entrypoint.sh /usr/local/bin/

RUN npm config set unsafe-perm true && cd /usr/local/bin/ && npm install -g harperdb && npm install -g modclean && \
   cd /usr/local/lib/node_modules/harperdb && npm dedupe && modclean -r -D node_modules && \
   npm remove -g modclean && rm -rf /usr/local/lib/node_modules/harperdb/node_modules/socketcluster/sample/ && \
   npm cache clean --force && \
   mkdir -p /opt/harperdb/hdb && chown -R node:node /opt/harperdb/hdb && chown -R node:node /usr/local/lib/node_modules/harperdb && \
   rm -rf /usr/local/lib/node_modules/harperdb/docs && mv /home/node/docs /usr/local/lib/node_modules/harperdb/

USER node

#Update data directory permissions

RUN mkdir /home/node/hdb_tmp && /usr/local/bin/harperdb install --TC_AGREEMENT yes --HDB_ROOT /opt/harperdb/hdb --HTTP_PORT 9925 --HTTPS_PORT 31283 --HDB_ADMIN_USERNAME HDB_ADMIN --HDB_ADMIN_PASSWORD password --CLUSTERING_USERNAME cluster_user --CLUSTERING_PASSWORD password --CLUSTERING_PORT 1111 --NODE_NAME docker_node && \
 rsync -r /opt/harperdb/hdb/* /home/node/hdb_tmp/ &&  rm -rf /opt/harperdb/hdb/* 

#Expose container directory to be mountable onto host directory
VOLUME /opt/harperdb/hdb 
#When login ssh the container will do all commands relative to this directory
WORKDIR /home/node/

#docker run allows arguments that can be passed to a script; this script. Provides install, and register functions.
ENTRYPOINT ["/sbin/tini","--","entrypoint.sh"]
#default command when, docker run <image name> with no other arguments.
CMD ["/usr/local/bin/hdb_docker_init.sh"]

