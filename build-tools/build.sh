#!/usr/bin/env bash

set -e

echo -e "\n📦 Installing core deps"
npm install --ignore-scripts

echo -e "\n📦 Building project"
npm run build || true

echo -e "\n📦 Creating shrinkwrap"
npm shrinkwrap

echo -e "\n📦 Pruning devDependencies from shrinkwrap"
node build-tools/prune-shrinkwrap-dev.mjs npm-shrinkwrap.json

# Order is load-bearing: the react-native prune walks production edges only, so it must
# see a shrinkwrap whose dev entries are already gone or it will refuse to write.
echo -e "\n📦 Pruning react-native tree from shrinkwrap"
node build-tools/prune-shrinkwrap-react-native.mjs npm-shrinkwrap.json

./build-tools/build-studio.sh

echo -e "\n📦 Building package"
npm pack

version=$(npm pkg get version | tr -d \")
packageFile="harper-${version}.tgz"
echo -e "\n📦 Built Harper Pro ${version} in ${packageFile}"
echo "📦 Run 'npm publish ${packageFile}' to release"
