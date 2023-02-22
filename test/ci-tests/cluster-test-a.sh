#!/bin/bash
# The first 5 parameters are the public_ips and the next 5 are dns_names
# This is because bash expands the array when used as a command line arg
public_ips=($1 $2 $3 $4 $5)
public_dns_names=($6 $7 $8 $9 ${10})

# Run the cluster tests from the first test VM
. /home/ubuntu/.nvm/nvm.sh
. /home/ubuntu/.nvm/bash_completion

npm --loglevel=error install -g newman
npm --loglevel=error install -g newman-reporter-html
npm --loglevel=error install -g newman-reporter-htmlextra

cd /home/ubuntu/harperdb/integrationTests/

# Set node host names in postman env vars file
sed -in "s/ClstrTestA1/${public_ips[0]}/" clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestA2/${public_ips[1]}/" clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestA3/${public_ips[2]}/" clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestA4/${public_ips[3]}/" clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestA5/${public_ips[4]}/" clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json

sed -in "s/ClstrTestANode1/${public_dns_names[0]%%.*}/" clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestANode2/${public_dns_names[1]%%.*}/" clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestANode3/${public_dns_names[2]%%.*}/" clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestANode4/${public_dns_names[3]%%.*}/" clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestANode5/${public_dns_names[4]%%.*}/" clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json

newman run clusterTests/clusterTestA/Five_Node_Cluster.postman_collection.json -e clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json --reporters cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html  --delay-request 100 --insecure --reporter-cli-show-timestamps
