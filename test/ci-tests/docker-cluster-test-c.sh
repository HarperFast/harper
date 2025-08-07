#!/usr/bin/env bash

harperdb_version=$1
docker_image="${DOCKER_IMAGE:-harperdb/harperdb}"
container_tarball="${CONTAINER_TARBALL:-docker-harperdb_${harperdb_version}.tar}"

# Install and start docker
export DEBIAN_FRONTEND=noninteractive
sudo apt-get -qq update
sudo apt-get -qq install -y docker.io

sudo systemctl start docker
sleep 25

cd /home/ubuntu

sudo docker load -i ${container_tarball}

cd harperdb

sudo docker network create ClstrTestC

# docker inspect makes sure the image was imported correctly. we only need to check once. exit 1 if it's not here
sudo docker image inspect ${docker_image}:${harperdb_version} > /dev/null || exit 1

sudo docker run -d --restart no --network ClstrTestC --name ClstrTestC1 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestC1 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}
sudo docker run -d --restart no --network ClstrTestC --name ClstrTestC2 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestC2 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}
sudo docker run -d --restart no --network ClstrTestC --name ClstrTestC3 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestC3 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}
sudo docker run -d --restart no --network ClstrTestC --name ClstrTestC4 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestC4 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}

sleep 30s

# Install newman and newman reporters on first container
sudo docker exec ClstrTestC1 /bin/bash -c 'cat /home/harperdb/hdb/harperdb-config.yaml| grep nodeName'
sudo docker exec ClstrTestC1 /bin/bash -c 'npm install -g newman newman-reporter-teamcity newman-reporter-html newman-reporter-htmlextra'

# modify integrationTests folder before copy
sed -in "s/TEST_C_NODE1_HOST/ClstrTestC1/" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE2_HOST/ClstrTestC2/" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE3_HOST/ClstrTestC3/" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE4_HOST/ClstrTestC4/" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json

sed -in "s/TEST_C_NODE1_NAME/ClstrTestC1/" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE2_NAME/ClstrTestC2/" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE3_NAME/ClstrTestC3/" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s/TEST_C_NODE4_NAME/ClstrTestC4/" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json

sed -in "s/ubuntu/harperdb/" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json

# Escape special characters
S3_KEY=$(printf '%s\n' "$S3_KEY" | sed 's/[[\.*^$()+?{|]/\\&/g')
S3_SECRET=$(printf '%s\n' "$S3_SECRET" | sed 's/[[\.*^$()+?{|]/\\&/g')

# Inject credentials from environment variables
sed -in "s|\"value\": \"PLACEHOLDER_USERNAME\"|\"value\": \"$HDB_ADMIN_USERNAME\"|" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s|\"value\": \"PLACEHOLDER_PASSWORD\"|\"value\": \"$HDB_ADMIN_PASSWORD\"|" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s|\"value\": \"PLACEHOLDER_S3_KEY\"|\"value\": \"$S3_KEY\"|" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json
sed -in "s|\"value\": \"PLACEHOLDER_S3_SECRET\"|\"value\": \"$S3_SECRET\"|" integrationTests/clusterTests/clusterTestC/cluster_test_c_env.json

# Copy integrationTests folder to first container
sudo docker exec ClstrTestC1 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker cp integrationTests/ ClstrTestC1:/home/harperdb/harperdb/

# Copy test folder to containers
sudo docker exec ClstrTestC2 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker exec ClstrTestC3 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker exec ClstrTestC4 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker cp test/ ClstrTestC1:/home/harperdb/harperdb/
sudo docker cp test/ ClstrTestC2:/home/harperdb/harperdb/
sudo docker cp test/ ClstrTestC3:/home/harperdb/harperdb/
sudo docker cp test/ ClstrTestC4:/home/harperdb/harperdb/

# Run cluster tests from first container
sudo docker exec --user root ClstrTestC1 /bin/bash -c 'mkdir -p ~/harperdb/integrationTests/newman && chmod 777 ~/harperdb/integrationTests/newman'
sudo docker exec ClstrTestC1 /bin/bash -c 'cd ~/harperdb/integrationTests/ && newman run clusterTests/clusterTestC/cluster_test_c.json -e clusterTests/clusterTestC/cluster_test_c_env.json --reporters cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html  --delay-request 2000 --insecure --reporter-cli-show-timestamps'
test_status=$?

artifact_dir="artifact"
mkdir -p $artifact_dir/ClstrTestC1/
mkdir -p $artifact_dir/ClstrTestC2/
mkdir -p $artifact_dir/ClstrTestC3/
mkdir -p $artifact_dir/ClstrTestC4/

# Copy log and config files from containers
sudo docker cp --follow-link ClstrTestC1:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestC1/
sudo docker cp --follow-link ClstrTestC2:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestC2/
sudo docker cp --follow-link ClstrTestC3:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestC3/
sudo docker cp --follow-link ClstrTestC4:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestC4/
sudo docker cp --follow-link ClstrTestC1:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestC1/
sudo docker cp --follow-link ClstrTestC2:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestC2/
sudo docker cp --follow-link ClstrTestC3:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestC3/
sudo docker cp --follow-link ClstrTestC4:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestC4/

# Capture sudo docker logs
sudo docker logs ClstrTestC1 > $artifact_dir/ClstrTestC1/docker_log.log
sudo docker logs ClstrTestC2 > $artifact_dir/ClstrTestC2/docker_log.log
sudo docker logs ClstrTestC3 > $artifact_dir/ClstrTestC3/docker_log.log
sudo docker logs ClstrTestC4 > $artifact_dir/ClstrTestC4/docker_log.log

# Capture newman reports
sudo docker cp --follow-link ClstrTestC1:/home/harperdb/harperdb/integrationTests/newman/extra_report.html $artifact_dir
sudo docker cp --follow-link ClstrTestC1:/home/harperdb/harperdb/integrationTests/newman/report.html $artifact_dir

# Chown so we can scp
sudo chown -R ubuntu:ubuntu $artifact_dir 

exit $test_status