#!/bin/bash

set -ex

script_dir=$(dirname $0)

pwd
apt-get update && apt-get install -y build-essential jq sudo rsync

bytenode_version="$(jq -r ".dependencies.bytenode" package.json)"

npm install -g bytenode@$bytenode_version
npm install -g dot-json
npm install -g bundle-dependencies

go_version=$(jq -r '.engines."go-lang"' package.json)
echo $go_version

wget https://go.dev/dl/go${go_version}.linux-amd64.tar.gz
tar -C /usr/local -xzf go${go_version}.linux-amd64.tar.gz
rm -f go${go_version}.linux-amd64.tar.gz

export PATH=$PATH:/usr/local/go/bin
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.profile

mkdir /root/.cache
export GOCACHE=/tmp/

$script_dir/build.sh