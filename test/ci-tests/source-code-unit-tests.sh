#!/bin/bash
set -e

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

npm --loglevel=error install mocha -g
cd /home/ubuntu/harperdb/bin/
node harperdb.js stop
npm run test

npx pm2 kill


# Re-register HarperDB after unit tests
cd /home/ubuntu/harperdb/utility/devops
node register.js --reset_license --ram_allocation=16384

cd /home/ubuntu/harperdb
sudo chmod +x ./utility/devops/build/build-studio.sh
./utility/devops/build/build-studio.sh

cd /home/ubuntu/harperdb/bin/
node harperdb.js start