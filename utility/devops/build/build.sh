#!/bin/bash

# only if we have a system with apt-get
if command -v apt-get &> /dev/null; then
  apt-get update && apt-get install -y jq rsync
fi

npm install -g dot-json

node_version_installed="$(node -v)"

if ! command -v jq &> /dev/null
then
  echo "jq must be installed, install jq using your OS package manager"
  exit 1
fi

if ! command -v dot-json &> /dev/null
then
  echo "dot-json must be installed, run command 'npm install dot-json -g'"
  exit 1
fi

#remove existing node_modules
rm -rf ./node_modules/
rm -rf ./npm_pack/

# npm install from source
# we need to install because we have build.js that run that need to be installed
# --silent sets npm log level to silent
npm --silent install --legacy-peer-deps
sleep 2

# Remove architecture specific binaries from dependencies
rm -rf dependencies/*/

# Obfuscate code
node ./utility/devops/build/build.js

# Rerun install with production to remove devDependencies packages
# --production prevents install of dev dependencies
npm --silent install --production --legacy-peer-deps

# Pull in application-template repo
git submodule update --init --recursive

# # Copy code to package creation directory
rsync --exclude=".*" --recursive ./application-template ./npm_pack/

# Grab the postinstall script commands
post_install="$(jq -r '.scripts."postinstall"' package.json)"

# Delete scripts and devDependencies from ./npm_pack/package.json
dot-json ./npm_pack/package.json devDependencies --delete
dot-json ./npm_pack/package.json scripts --delete

cd ./npm_pack/
rm -rf ./node_modules/
# Add the postinstall script back
dot-json ./package.json scripts.postinstall "$post_install"

# create a lock file
npm install --package-lock-only
npm shrinkwrap

dot-json ./npm_pack/package.json overrides --delete

cd ../

# Copy LICENSE file
cp LICENSE ./npm_pack/

# Append README with commit ID
git rev-parse HEAD >> ./npm_pack/README.md

./utility/devops/build/build-studio.sh

mkdir npm_pack/studio
cp -r ./studio/build-local ./npm_pack/studio/build-local
# Create package from package creation directory
npm --force pack ./npm_pack/