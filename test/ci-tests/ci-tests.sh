#!/bin/bash
set -e

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

npm --loglevel=error install -g newman
npm --loglevel=error install -g newman-reporter-html
npm --loglevel=error install -g newman-reporter-htmlextra

sudo apt-get update
sudo apt-get install -y net-tools gdb

cd /home/ubuntu/harperdb/integrationTests

# Correct path to CSV files for integration tests
sed -i 's/\/usr\/csv\//\/home\/ubuntu\/harperdb\/test\/data\/integrationTestsCsvs\//g' Int_test_env_var.json

# Inject credentials from environment variables
sed -i "s/\"value\": \"PLACEHOLDER_USERNAME\"/\"value\": \"${HDB_ADMIN_USERNAME}\"/" Int_test_env_var.json
sed -i "s/\"value\": \"PLACEHOLDER_PASSWORD\"/\"value\": \"${HDB_ADMIN_PASSWORD}\"/" Int_test_env_var.json
sed -i "s/\"value\": \"PLACEHOLDER_S3_KEY\"/\"value\": \"${S3_KEY}\"/" Int_test_env_var.json
sed -i "s/\"value\": \"PLACEHOLDER_S3_SECRET\"/\"value\": \"${S3_SECRET}\"/" Int_test_env_var.json

cat Int_test_env_var.json | grep "integrationTestsCsvs"

newman run HarperDB_Integration_Tests.json -e Int_test_env_var.json --timeout-request 30000 --reporters cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html --insecure --reporter-cli-show-timestamps || gdb node /var/lib/apport/coredump/* --batch -ex=backtrace || gdb node /home/ubuntu/*core* --batch -ex=backtrace
netstat -l -p