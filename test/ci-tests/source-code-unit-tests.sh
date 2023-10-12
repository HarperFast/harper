#!/bin/bash
set -e

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

npm --loglevel=error install mocha -g
cd /home/ubuntu/harperdb/bin/
node harperdb.js stop
ps -ef | grep pm2 || echo "no ps?"
npm run cover:test
ps -ef | grep pm2 || echo "no ps?"
npx pm2 kill
ps -ef | grep pm2 || echo "no ps?"

# Re-register HarperDB after unit tests
cd /home/ubuntu/harperdb/utility/devops
node register.js --reset_license --ram_allocation=16384

ps -ef | grep pm2 || echo "no ps?"
cd /home/ubuntu/harperdb/bin/
node harperdb.js &
sleep 5