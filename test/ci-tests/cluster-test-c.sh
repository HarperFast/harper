#!/bin/bash
# The first 4 parameters are the public_ips and the next 4 are dns_names
# This is because bash expands the array when used as a command line arg
public_ips=($1 $2 $3 $4)
public_dns_names=($5 $6 $7 $8)

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

npm --loglevel=error install -g newman
npm --loglevel=error install -g newman-reporter-html
npm --loglevel=error install -g newman-reporter-htmlextra

cd /home/ubuntu/harperdb/integrationTests/

# Set node host names in postman env vars file
sed -in "s/TEST_C_NODE1_HOST/${public_ips[0]}/" clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE2_HOST/${public_ips[1]}/" clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE3_HOST/${public_ips[2]}/" clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE4_HOST/${public_ips[3]}/" clusterTests/clusterTestC/cluster_test_c_env.json

# Set node names in postman env vars file 2 percent signs escapes for trimming string
sed -in "s/TEST_C_NODE1_NAME/${public_dns_names[0]%%.*}/" clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE2_NAME/${public_dns_names[1]%%.*}/" clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE3_NAME/${public_dns_names[2]%%.*}/" clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE4_NAME/${public_dns_names[3]%%.*}/" clusterTests/clusterTestC/cluster_test_c_env.json

newman run clusterTests/clusterTestC/cluster_test_c.json -e clusterTests/clusterTestC/cluster_test_c_env.json --reporters cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html  --delay-request 500 --insecure --reporter-cli-show-timestamps