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

# Validate required environment variables
echo "Validating environment variables..."
if [ -z "$HDB_ADMIN_USERNAME" ] || [ -z "$HDB_ADMIN_PASSWORD" ] || [ -z "$S3_KEY" ] || [ -z "$S3_SECRET" ]; then
    echo "Error: Required environment variables not set"
    [ -z "$HDB_ADMIN_USERNAME" ] && echo "HDB_ADMIN_USERNAME: (not set)"
    [ -z "$HDB_ADMIN_PASSWORD" ] && echo "HDB_ADMIN_PASSWORD: (not set)"  
    [ -z "$S3_KEY" ] && echo "S3_KEY: (not set)"
    [ -z "$S3_SECRET" ] && echo "S3_SECRET: (not set)"
    exit 1
fi
echo "All required environment variables are set"

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

# Inject credentials from environment variables
sed -i "s/\"value\": \"PLACEHOLDER_USERNAME\"/\"value\": \"${HDB_ADMIN_USERNAME}\"/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -i "s/\"value\": \"PLACEHOLDER_PASSWORD\"/\"value\": \"${HDB_ADMIN_PASSWORD}\"/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -i "s/\"value\": \"PLACEHOLDER_S3_KEY\"/\"value\": \"${S3_KEY}\"/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -i "s/\"value\": \"PLACEHOLDER_S3_SECRET\"/\"value\": \"${S3_SECRET}\"/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json

newman run clusterTests/clusterTestCPlexus/cluster_test_c.json -e clusterTests/clusterTestCPlexus/cluster_test_c_env.json --reporters cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html  --delay-request 1500 --insecure --reporter-cli-show-timestamps