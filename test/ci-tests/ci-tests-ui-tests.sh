#!/bin/bash
set -e

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

pwd
ls -al /home/ubuntu/
cd /home/ubuntu/ui-tests/

echo "npm install..."
npm install

echo "Install Playwright Browsers"
npx playwright install --with-deps chromium

echo "Run Playwright tests"
npx playwright test

sleep 10