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

# Validate required environment variables
echo "Verifying environment variables..."
# Loop through required environment variables to verify their presence and display masked values
for var in HDB_ADMIN_USERNAME HDB_ADMIN_PASSWORD S3_KEY S3_SECRET; do
	value=${!var}
	if [ -n "$value" ]; then
		# Sanitize and display the first 3 and last 3 characters of the variable for masking sensitive data
		sanitized_value=$(printf '%q' "${value}")
		echo "$var: ${sanitized_value:0:3}...${sanitized_value: -3}"
	else
		echo "$var: (not set)"
	fi
done

# Escape special characters
S3_KEY=$(printf '%s\n' "$S3_KEY" | sed 's/[\/&\\]/\\&/g')
S3_SECRET=$(printf '%s\n' "$S3_SECRET" | sed 's/[\/&\\]/\\&/g')

# Inject credentials from environment variables
sed -i "s/\"value\": \"PLACEHOLDER_USERNAME\"/\"value\": \"${HDB_ADMIN_USERNAME}\"/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -i "s/\"value\": \"PLACEHOLDER_PASSWORD\"/\"value\": \"${HDB_ADMIN_PASSWORD}\"/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -i "s/\"value\": \"PLACEHOLDER_S3_KEY\"/\"value\": \"${S3_KEY}\"/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json
sed -i "s/\"value\": \"PLACEHOLDER_S3_SECRET\"/\"value\": \"${S3_SECRET}\"/" clusterTests/clusterTestCPlexus/cluster_test_c_env.json

newman run clusterTests/clusterTestCPlexus/cluster_test_c.json -e clusterTests/clusterTestCPlexus/cluster_test_c_env.json --reporters cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html  --delay-request 1500 --insecure --reporter-cli-show-timestamps