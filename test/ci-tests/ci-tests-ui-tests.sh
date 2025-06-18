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
npx playwright test --reporter=html --reporter-options open=never || exit_code=$?
if [ "$exit_code" -eq 255 ]; then
  echo "Got exit code 255 but continuing..."
  exit 0
else
  exit "$exit_code"
fi