#!/usr/bin/env bash

rm -Rf studio-src studio
mkdir studio-src
cd studio-src
git clone --branch prod --single-branch --depth 1 https://github.com/HarperFast/studio.git .
npm install -g pnpm
pnpm install
VITE_STUDIO_VERSION="v$(jq -r '.version' ../package.json)" pnpm run build:local
cd ..
mkdir studio
mv ./studio-src/web ./studio/web
