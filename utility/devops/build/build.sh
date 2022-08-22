#!/bin/bash

node_version_installed="$(node -v)"
node_version="v$(npm run env | grep npm_package_engines_node | cut -d '=' -f 2)"

if ! [ "$node_version_installed" = "$node_version" ]; then
    echo "Node.js $node_version must be installed"
    exit
fi

if ! command -v jq &> /dev/null
then
  echo "jq must be installed, install jq using your OS package manager"
  exit
fi

if ! command -v dot-json &> /dev/null
then
  echo "dot-json must be installed, run command 'npm install dot-json -g'"
  exit
fi

#remove existing node_modules
rm -rf ./node_modules/
rm -rf ./npm_pack/

# npm install from source
# we need to install because we have build.js that run that need to be installed
# --silent sets npm log level to silent
# --production prevents install of dev dependencies
npm --silent install --production --legacy-peer-deps
sleep 2

# Obfuscate code
node ./utility/devops/build/build.js

# Pull in custom_function_template repo
git submodule update --init --recursive

# # Copy code to package creation directory
rsync --exclude=".*" --recursive ./custom_function_template ./npm_pack/

# Grab the postinstall script commands
post_install="$(jq -r '.scripts."postinstall"' package.json)"

# Delete scripts and devDependencies from ./npm_pack/package.json
dot-json ./npm_pack/package.json devDependencies --delete
dot-json ./npm_pack/package.json dependencies.esbuild --delete
dot-json ./npm_pack/package.json scripts --delete

cd ./npm_pack/
# Add the postinstall script back
npm set-script postinstall "$post_install"
cd ../

# Move LICENSE file to ./license dir
mkdir ./npm_pack/license
mv LICENSE ./npm_pack/license

# Append README with commit ID
git rev-parse HEAD >> ./npm_pack/README.md

# Create package from package creation directory
npm --force pack ./npm_pack/