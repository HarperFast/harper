#!/usr/bin/env bash

api_host=$1
node_name=$2
delay=$3

if [[ -n "$delay" ]]; then
  sleep "$delay"
fi

add_node() {
  curl -sfk -u admin:admin "https://$api_host:9925" -H "Content-Type: application/json" \
  -d "{\"operation\": \"add_node\", \"url\": \"wss://$node_name:9933\", \"verify_tls\": false, \
  \"authorization\": {\"username\": \"admin\", \"password\": \"admin\"}}"
}

max_attempts=100
attempt=0
until add_node; do
  echo -n ". "
  if [[ $((++attempt)) -gt $max_attempts ]]; then
    echo "Exceeded $max_attempts attempts to add node to cluster; exiting"
    exit 1
  fi
  sleep 1
done
