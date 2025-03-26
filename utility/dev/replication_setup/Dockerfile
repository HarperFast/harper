FROM alpine:latest

RUN apk add curl

COPY --chmod=555 add_node.sh /usr/local/bin/

ENTRYPOINT ["/usr/local/bin/add_node.sh"]
