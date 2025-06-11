#!/bin/bash
# The first 4 parameters are the private_ips and the next 4 are dns_names
# This is because bash expands the array when used as a command line arg
private_ips=($1 $2 $3 $4)
private_dns_names=($5 $6 $7 $8)

. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

npm --loglevel=error install -g newman
npm --loglevel=error install -g newman-reporter-html
npm --loglevel=error install -g newman-reporter-htmlextra

cd /home/ubuntu/harperdb/integrationTests/

# Set node host names in postman env vars file
sed -in "s/ClstrTestB1/${private_ips[0]}/" clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestB2/${private_ips[1]}/" clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestB3/${private_ips[2]}/" clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestB4/${private_ips[3]}/" clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json

# Set node names in postman env vars file 4 percent signs escapes for trimming string
sed -in "s/ClstrTestBNode1/${private_dns_names[0]%%.*}/" clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestBNode2/${private_dns_names[1]%%.*}/" clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestBNode3/${private_dns_names[2]%%.*}/" clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestBNode4/${private_dns_names[3]%%.*}/" clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json

# Inject credentials from environment variables
sed -i "s/\"value\": \"PLACEHOLDER_USERNAME\"/\"value\": \"${HDB_ADMIN_USERNAME}\"/" clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -i "s/\"value\": \"PLACEHOLDER_PASSWORD\"/\"value\": \"${HDB_ADMIN_PASSWORD}\"/" clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json

# Increase retry limit
#sed -in 's/"value": "7",/"value": "100",/' clusterTests/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
cat clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
newman run clusterTests/clusterTestB/Four_Node_Cluster_Tests.postman_collection.json -e clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json --reporters cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html  --delay-request 2000 --insecure --reporter-cli-show-timestamps