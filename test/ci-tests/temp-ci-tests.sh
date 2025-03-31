#!/bin/bash
set -e

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

cd /home/ubuntu/harperdb/integrationTests/apiTests

npm install

node tests/temp.js