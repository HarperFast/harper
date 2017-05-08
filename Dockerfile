# Node.js app Docker file

FROM ubuntu


ENV DEBIAN_FRONTEND noninteractive

RUN apt-get update
RUN apt-get -qq update
RUN apt-get install -y curl
# TODO could uninstall some build dependencies
RUN curl -sL https://deb.nodesource.com/setup_7.x | /bin/bash -
RUN apt-get install -y nodejs

VOLUME ["/harperdb","/opt/HarperDB/hdb"]

ADD . /haperdb
RUN cd /harperdb && npm install -g npm-cli-login && npm install -g pm2
RUN NPM_USER=zaxary NPM_PASS=BFfsng5KFaKGJXQ0A15UqRqp NPM_EMAIL=zachary@harperdb.io npm-cli-login && npm install



EXPOSE 5299

WORKDIR /harperdb

CMD ["pm2", "start utility/devops/ecosystem.config.js"]
