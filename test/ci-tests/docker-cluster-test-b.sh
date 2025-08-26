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

# prep tests and output directories
cd harperdb

# modify integrationTests folder before copy
sed -in "s/ClstrTestBNode1/ClstrTestB1/" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestBNode2/ClstrTestB2/" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestBNode3/ClstrTestB3/" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestBNode4/ClstrTestB4/" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ubuntu/harperdb/" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json

# Inject credentials from environment variables
sed -in "s|\"value\": \"PLACEHOLDER_USERNAME\"|\"value\": \"$HDB_ADMIN_USERNAME\"|" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s|\"value\": \"PLACEHOLDER_PASSWORD\"|\"value\": \"$HDB_ADMIN_PASSWORD\"|" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json

# create output directories for test
artifact_dir="artifact"
mkdir --mode a+rwx -p $artifact_dir/ClstrTestB1/newman $artifact_dir/ClstrTestB1/log
mkdir --mode a+rwx -p $artifact_dir/ClstrTestB2/ $artifact_dir/ClstrTestB2/log
mkdir --mode a+rwx -p $artifact_dir/ClstrTestB3/ $artifact_dir/ClstrTestB3/log
mkdir --mode a+rwx -p $artifact_dir/ClstrTestB4/ $artifact_dir/ClstrTestB4/log

# create network
sudo docker network create ClstrTestB

# set shared args for docker
docker_args="-d --restart no --network ClstrTestB -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT=\"4sADRM2e7dd501d7db58bb02d35bd0745146423a1\" -e HARPERDB_LICENSE='{\"license_key\":\"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61\",\"company\":\"harperdb.io\"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}"

# docker inspect makes sure the image was imported correctly. we only need to check once. exit 1 if it's not here
sudo docker image inspect ${docker_image}:${harperdb_version} > /dev/null || exit 1

# launch test containers
sudo docker run --name ClstrTestB1 -e NODE_NAME=ClstrTestB1 -v `pwd`/integrationTests/:/home/harperdb/harperdb/integrationTests/ -v `pwd`/$artifact_dir/ClstrTestB1/newman/:/home/harperdb/harperdb/integrationTests/newman -v `pwd`/$artifact_dir/ClstrTestB1/log:/home/harperdb/hdb/log ${docker_args}
sudo docker run --name ClstrTestB2 -e NODE_NAME=ClstrTestB2 -v `pwd`/test/:/home/harperdb/harperdb/test:z -v `pwd`/$artifact_dir/ClstrTestB2/log:/home/harperdb/hdb/log ${docker_args}
sudo docker run --name ClstrTestB3 -e NODE_NAME=ClstrTestB3 -v `pwd`/test/:/home/harperdb/harperdb/test:z -v `pwd`/$artifact_dir/ClstrTestB3/log:/home/harperdb/hdb/log ${docker_args}
sudo docker run --name ClstrTestB4 -e NODE_NAME=ClstrTestB4 -v `pwd`/test/:/home/harperdb/harperdb/test:z -v `pwd`/$artifact_dir/ClstrTestB4/log:/home/harperdb/hdb/log ${docker_args}

sleep 30s

# Install newman and newman reporters on first container
sudo docker exec ClstrTestB1 /bin/bash -c 'cat /home/harperdb/hdb/harperdb-config.yaml| grep nodeName'
sudo docker exec ClstrTestB1 /bin/bash -c 'npm install -g newman newman-reporter-teamcity newman-reporter-html newman-reporter-htmlextra'

# Run cluster tests from first container
sudo docker exec --user root ClstrTestB1 /bin/bash -c 'mkdir -p ~/harperdb/integrationTests/newman && chmod 777 ~/harperdb/integrationTests/newman'
sudo docker exec ClstrTestB1 /bin/bash -c 'cd ~/harperdb/integrationTests/ && newman run clusterTests/clusterTestB/Four_Node_Cluster_Tests.postman_collection.json -e clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json --reporters teamcity,cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html --delay-request 1000 --insecure --reporter-cli-show-timestamps'
test_status=$?

# Capture sudo docker logs
sudo docker logs ClstrTestB1 > $artifact_dir/ClstrTestB1/docker_log.log
sudo docker logs ClstrTestB2 > $artifact_dir/ClstrTestB2/docker_log.log
sudo docker logs ClstrTestB3 > $artifact_dir/ClstrTestB3/docker_log.log
sudo docker logs ClstrTestB4 > $artifact_dir/ClstrTestB4/docker_log.log

# Copy config files from containers
sudo docker cp --follow-link ClstrTestB1:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestB1/
sudo docker cp --follow-link ClstrTestB2:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestB2/
sudo docker cp --follow-link ClstrTestB3:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestB3/
sudo docker cp --follow-link ClstrTestB4:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestB4/

# Chown so we can scp
sudo chown -R ubuntu:ubuntu $artifact_dir

exit $test_status