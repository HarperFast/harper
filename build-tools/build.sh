#!/usr/bin/env bash

set -e

echo -e "\n📦 Installing core deps"
npm install

echo -e "\n📦 Building project"
npm run build || true

echo -e "\n📦 Creating shrinkwrap"
npm shrinkwrap

./build-tools/build-studio.sh

echo -e "\n📦 Building package"
npm pack

version=$(npm pkg get version | tr -d \")
packageFile="harper-${version}.tgz"
echo -e "\n📦 Built Harper Pro ${version} in ${packageFile}"
echo "📦 Run 'npm publish ${packageFile}' to release"
