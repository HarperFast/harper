FROM node:23

# NB: This Dockerfile makes images only appropriate for internal Harper development.
# Do NOT share them outside the company!!!

RUN mkdir /opt/harper
WORKDIR /opt/harper

COPY package.json package-lock.json ./

# These are all to appease the NATS installation, which this image is not intended to use
# Maybe optimize this to skip NATS somehow in the future?
COPY launchServiceScripts/launchInstallNATSServer.js ./launchServiceScripts/
COPY bin/dev.js ./bin/
COPY utility/packageUtils.js utility/hdbTerms.ts ./utility/
COPY server/nats/utility/* ./server/nats/utility/

RUN npm ci

COPY . /opt/harper/
RUN rm -rf ts-build && npx tsc || true

RUN npm link

ENV TC_AGREEMENT=yes \
    ROOTPATH=/var/local/hdb \
    OPERATIONSAPI_NETWORK_PORT=9925 \
    HTTP_PORT=9926 \
    LOGGING_STDSTREAMS=true

EXPOSE 9925 9926 9932 9933

HEALTHCHECK CMD ["curl", "-sf", "http://localhost:9925/health" ]

CMD ["harperdb"]
