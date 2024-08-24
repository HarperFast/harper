#!/bin/bash
# The first 4 parameters are the private_ips and the next 4 are dns_names
# This is because bash expands the array when used as a command line arg
private_ips=($1 $2 $3 $4)
public_dns_names=($5 $6 $7 $8)

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

npm --loglevel=error install -g newman
npm --loglevel=error install -g newman-reporter-html
npm --loglevel=error install -g newman-reporter-htmlextra

cd /home/ubuntu/harperdb/integrationTests/

# Set node host names in postman env vars file
sed -in "s/TEST_C_NODE1_HOST/${private_ips[0]}/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -in "s/TEST_C_NODE2_HOST/${private_ips[1]}/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -in "s/TEST_C_NODE3_HOST/${private_ips[2]}/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -in "s/TEST_C_NODE4_HOST/${private_ips[3]}/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json

# Set node names in postman env vars file 2 percent signs escapes for trimming string
sed -in "s/TEST_C_NODE1_NAME/node-1/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -in "s/TEST_C_NODE2_NAME/node-2/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -in "s/TEST_C_NODE3_NAME/node-3/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -in "s/TEST_C_NODE4_NAME/node-4/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json

newman run clusterTests/clusterTestCPlexus/cluster_test_c.json -e clusterTests/clusterTestCPlexus/cluster_test_c_env.json --reporters cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html  --delay-request 1500 --insecure --reporter-cli-show-timestamps