#!/bin/bash
set -e

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

npm --loglevel=error install mocha -g
cd /home/ubuntu/harperdb/bin/
node harperdb.js stop
npm run cover:test

npx pm2 kill

cd /home/ubuntu/harperdb
sudo chmod +x ./utility/devops/build/build-studio.sh
./utility/devops/build/build-studio.sh

cd /home/ubuntu/harperdb/bin/
nohup node harperdb.js &