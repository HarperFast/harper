#!/bin/bash
set -e

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

cd /home/ubuntu/harperdb/integrationTests/apiTests

npm install

HDB_ADMIN_USERNAME=$3 HDB_ADMIN_PASSWORD=$4 S3_KEY=$1 S3_SECRET=$2 node --test-reporter spec --test-reporter-destination report.txt --test-reporter spec --test-reporter-destination stdout --experimental-default-type="module" tests/testSuite.js