#!/bin/bash
set -e

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

cd /home/ubuntu/harperdb/integrationTests/apiTests

npm install

HDB_ADMIN_USERNAME=$1 HDB_ADMIN_PASSWORD=$2 S3_KEY=$3 S3_SECRET=$4 node --test-reporter spec --test-reporter-destination report.txt --test-reporter spec --test-reporter-destination stdout --experimental-default-type="module" tests/testSuite.js