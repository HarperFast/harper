# HarperDB Docker file
# In HarperDB repo. run: sudo docker build .
# Run Image after build with:
# sudo docker run -d -v /path/to/host/harperdb/data/dir:/opt/HarperDB/hdb -p 8080:5299 imagenumber_from_sudo docker images

FROM ubuntu


ENV DEBIAN_FRONTEND noninteractive

RUN apt-get update && apt-get install -y curl \
&& curl -sL https://deb.nodesource.com/setup_7.x | /bin/bash - \
&& apt-get install -y nodejs

VOLUME ["/opt/HarperDB/hdb"]

ADD . /opt/harperdb/
RUN cd /opt/harperdb && npm install -g npm-cli-login && npm install -g pm2 \
&& NPM_USER=zaxary NPM_PASS=BFfsng5KFaKGJXQ0A15UqRqp NPM_EMAIL=zachary@harperdb.io npm-cli-login \
&& npm install


EXPOSE 5299

WORKDIR /opt/harperdb

CMD ["pm2-docker","utility/devops/ecosystem.config.js"]
