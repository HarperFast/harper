#!/usr/bin/env bash

set -e

echo -e "\n📦 Installing core deps"
rm -f npm-shrinkwrap.json
npm ci --ignore-scripts

echo -e "\n📦 Building project"
# A stale dist/ would mask a declaration file the compiler stopped emitting.
rm -rf dist
npm run build

./build-tools/build-studio.sh

echo -e "\n📦 Preparing portable dependency bundle"
node build-tools/bundleDependencies.ts prepare "$PWD" "$PWD/node_modules/.cache/harper-package"

echo -e "\n📦 Building package"
npm pack ./node_modules/.cache/harper-package/package --ignore-scripts

version=$(npm pkg get version | tr -d \")
packageFile="harper-${version}.tgz"
mkdir node_modules/.cache/harper-package/packed
tar -xzf "$packageFile" --strip-components=1 -C node_modules/.cache/harper-package/packed
node build-tools/bundleDependencies.ts check "$PWD/node_modules/.cache/harper-package/packed" "$PWD/package-lock.json"
echo -e "\n📦 Built Harper ${version} in ${packageFile}"
echo "📦 Run 'npm publish ${packageFile}' to release"
