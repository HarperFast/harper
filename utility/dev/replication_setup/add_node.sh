#!/usr/bin/env sh

api_host=$1
node_name=$2
delay=$3

sleep "$delay"

add_node() {
  curl -sfk -u admin:admin "https://$api_host:9925" -H "Content-Type: application/json" \
  -d "{\"operation\": \"add_node\", \"url\": \"wss://$node_name:9933\", \"verify_tls\": false, \
  \"authorization\": {\"username\": \"admin\", \"password\": \"admin\"}}"
}

# TODO: Add a maximum number of attempts check here so this doesn't just loop forever if something's broken
until add_node; do
  echo -n ". "
  sleep 1
done
