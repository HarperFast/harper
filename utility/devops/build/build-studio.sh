#!/bin/bash

rm -Rf studio
mkdir studio
cd studio
git clone --branch prod --single-branch --depth 1 https://github.com/HarperDB/hdbms.git .
npm install -g pnpm
pnpm install
VITE_STUDIO_VERSION="v$(jq -r '.version' ../package.json)" pnpm run build:local
cd ..
