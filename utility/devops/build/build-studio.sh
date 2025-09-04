#!/bin/bash

cd studio
npm install -g pnpm
pnpm
pnpm run build:local
cd ..
