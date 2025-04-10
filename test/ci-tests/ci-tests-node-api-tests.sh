#!/bin/bash
set -e

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

cd /home/ubuntu/harperdb/integrationTests/apiTests

npm install

S3_KEY=$1 S3_SECRET=$2 node --experimental-default-type="module" --stack-trace-limit=2 tests/testSuite.js