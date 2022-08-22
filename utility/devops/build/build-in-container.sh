#!/bin/bash

set -ex

script_dir=$(dirname $0)

pwd
apt-get update && apt-get install -y jq sudo rsync

npm install -g dot-json

$script_dir/build.sh