#!/bin/bash
set -e

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

npm --loglevel=error install mocha -g
cd /home/ubuntu/harperdb/bin/
node harperdb.js stop
npm run test

node harperdb.js stop

cd /home/ubuntu/harperdb
sudo chmod +x ./utility/devops/build/build-studio.sh
./utility/devops/build/build-studio.sh

cd /home/ubuntu/harperdb/bin/
node harperdb.js start
