#!/bin/bash

apt-get update && apt-get install -y jq rsync

npm install -g dot-json
npm install -g bundle-dependencies

node_version_installed="$(node -v)"

if ! command -v jq &> /dev/null
then
  echo "jq must be installed, install jq using your OS package manager"
  exit 1
fi

node_version="v$(jq -r '.engines."preferred-node"' package.json)"

if ! [ "$node_version_installed" = "$node_version" ]; then
    echo "Node.js $node_version must be installed"
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

mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH

# npm install from source
# we need to install because we have build.js that run that need to be installed
# --silent sets npm log level to silent
# --production prevents install of dev dependencies
npm --silent install --production --legacy-peer-deps
sleep 2

# Download binaries for common platforms
supported_architectures=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64" "win32-x64")
for sa in ${supported_architectures[@]}
do
  mkdir dependencies/$sa
done
npm run download-prebuilds

# Obfuscate code
node ./utility/devops/build/build.js

# Pull in custom_function_template repo
git submodule update --init --recursive

# Copy code to package creation directory
rsync --exclude=".*" --recursive ./custom_function_template ./npm_pack/

# Grab the postinstall script commands
post_install="$(jq -r '.scripts."postinstall"' package.json)"

# Delete scripts and devDependencies from ./npm_pack/package.json
dot-json ./npm_pack/package.json devDependencies --delete
dot-json ./npm_pack/package.json dependencies.esbuild --delete
dot-json ./npm_pack/package.json scripts --delete
dot-json ./npm_pack/package.json overrides --delete

cd ./npm_pack/
# Add the postinstall script back
dot-json ./package.json scripts.postinstall "$post_install"
# Create bundleDependencies section of package.json
bundle-dependencies update
cd ../

# Copy LICENSE file
cp LICENSE ./npm_pack/

# Copy node_modules
cp --preserve --recursive ./node_modules/ ./npm_pack/

# Append README with commit ID
git rev-parse HEAD >> ./npm_pack/README.md

# Create package from package creation directory
npm --force pack ./npm_pack/