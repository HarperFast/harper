#!/usr/bin/env bash

docker_image="${DOCKER_IMAGE:-harperdb/harperdb}"
container_tarball="${CONTAINER_TARBALL:-docker-harperdb_${harperdb_version}.tar}"

# Install and start docker
export DEBIAN_FRONTEND=noninteractive
sudo apt-get -qq update
sudo apt-get -qq install -y docker.io

sudo systemctl start docker
sleep 25

cd /home/ubuntu
harperdb_version=$1
sudo docker load -i docker-harperdb_${harperdb_version}.tar 

cd harperdb

sudo docker network create ClstrTestB

sudo docker run -d --restart no --network ClstrTestB --name ClstrTestB1 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestB1 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}
sudo docker run -d --restart no --network ClstrTestB --name ClstrTestB2 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestB2 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}
sudo docker run -d --restart no --network ClstrTestB --name ClstrTestB3 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestB3 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}
sudo docker run -d --restart no --network ClstrTestB --name ClstrTestB4 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestB4 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}

sleep 30s

# Install newman and newman reporters on first container
sudo docker exec ClstrTestB1 /bin/bash -c 'cat /home/harperdb/hdb/harperdb-config.yaml| grep nodeName'
sudo docker exec ClstrTestB1 /bin/bash -c 'npm install -g newman newman-reporter-teamcity newman-reporter-html newman-reporter-htmlextra'

# modify integrationTests folder before copy
sed -in "s/ClstrTestBNode1/ClstrTestB1/" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestBNode2/ClstrTestB2/" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestBNode3/ClstrTestB3/" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ClstrTestBNode4/ClstrTestB4/" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json
sed -in "s/ubuntu/harperdb/" integrationTests/clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json

# Copy integrationTests folder to first container
sudo docker exec ClstrTestB1 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker cp integrationTests/ ClstrTestB1:/home/harperdb/harperdb/

# Copy test folder to containers
sudo docker exec ClstrTestB1 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker exec ClstrTestB2 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker exec ClstrTestB3 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker exec ClstrTestB4 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker cp test/ ClstrTestB1:/home/harperdb/harperdb/
sudo docker cp test/ ClstrTestB2:/home/harperdb/harperdb/
sudo docker cp test/ ClstrTestB3:/home/harperdb/harperdb/
sudo docker cp test/ ClstrTestB4:/home/harperdb/harperdb/

# Run cluster tests from first container
sudo docker exec --user root ClstrTestB1 /bin/bash -c 'mkdir -p ~/harperdb/integrationTests/newman && chmod 777 ~/harperdb/integrationTests/newman'
sudo docker exec ClstrTestB1 /bin/bash -c 'cd ~/harperdb/integrationTests/ && newman run clusterTests/clusterTestB/Four_Node_Cluster_Tests.postman_collection.json -e clusterTests/clusterTestB/Four_Node_Cluster_Tests_Env_vars.postman_environment.json --reporters teamcity,cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html  --delay-request 1000 --insecure --reporter-cli-show-timestamps'
test_status=$?

artifact_dir="artifact"
mkdir -p $artifact_dir/ClstrTestB1/
mkdir -p $artifact_dir/ClstrTestB2/
mkdir -p $artifact_dir/ClstrTestB3/
mkdir -p $artifact_dir/ClstrTestB4/

# Copy log and config files from containers
sudo docker cp --follow-link ClstrTestB1:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestB1/
sudo docker cp --follow-link ClstrTestB2:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestB2/
sudo docker cp --follow-link ClstrTestB3:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestB3/
sudo docker cp --follow-link ClstrTestB4:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestB4/
sudo docker cp --follow-link ClstrTestB1:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestB1/
sudo docker cp --follow-link ClstrTestB2:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestB2/
sudo docker cp --follow-link ClstrTestB3:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestB3/
sudo docker cp --follow-link ClstrTestB4:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestB4/

# Capture sudo docker logs
sudo docker logs ClstrTestB1 > $artifact_dir/ClstrTestB1/docker_log.log
sudo docker logs ClstrTestB2 > $artifact_dir/ClstrTestB2/docker_log.log
sudo docker logs ClstrTestB3 > $artifact_dir/ClstrTestB3/docker_log.log
sudo docker logs ClstrTestB4 > $artifact_dir/ClstrTestB4/docker_log.log

# Capture newman reports
sudo docker cp --follow-link ClstrTestB1:/home/harperdb/harperdb/integrationTests/newman/report.html $artifact_dir
sudo docker cp --follow-link ClstrTestB1:/home/harperdb/harperdb/integrationTests/newman/extra_report.html $artifact_dir

# Chown so we can scp
sudo chown -R ubuntu:ubuntu $artifact_dir 

exit $test_status