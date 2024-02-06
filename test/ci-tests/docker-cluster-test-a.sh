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
sudo docker load -i ${container_tarball}

cd harperdb

sudo docker network create ClstrTestA

sudo docker image inspect ${docker_image}:${harperdb_version} && sudo docker run -d --restart no --network ClstrTestA --name ClstrTestA1 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestA1 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}
sudo docker run -d --restart no --network ClstrTestA --name ClstrTestA2 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestA2 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}
sudo docker run -d --restart no --network ClstrTestA --name ClstrTestA3 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestA3 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}
sudo docker run -d --restart no --network ClstrTestA --name ClstrTestA4 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestA4 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}
sudo docker run -d --restart no --network ClstrTestA --name ClstrTestA5 -e HDB_ADMIN_USERNAME=admin -e HDB_ADMIN_PASSWORD=Abc1234! -e NODE_NAME=ClstrTestA5 -e CLUSTERING_PORT=12345 -e CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT=12345 -e CLUSTERING_USER=cluster_user -e CLUSTERING_PASSWORD=Abc1234! -e CLUSTERING=true -e HARPERDB_FINGERPRINT="4sADRM2e7dd501d7db58bb02d35bd0745146423a1" -e HARPERDB_LICENSE='{"license_key":"1373969b4cabd39e8b29c3c16e419c6abef4437d48168b4721e575610dcf656cf57016bd037cf1107f8232a1e94b7352c05b7c069560ac0e54ca156d3babc966289c664e5fb163e3429158a2f57afd39854ca51fa885abbca62f7e063a334498cd5ef0a038cbea80c6e063d174bbcc189a81dc4f2771ad90c9022cf20a322043ec4213fdef1d1e9eba36117c865acb6a13be3be218513ee80385e78bda0b9e27e7ec6532ac6e5416bc020f4f4be91cf6mofi25eYMW6aiRf6bd3d9b691699749569f6acd34a93e61","company":"harperdb.io"}' -e LOG_TO_STDSTREAMS=true -e LOGGING_LEVEL=trace -e LOG_TO_FILE=true -e CLUSTERING_REPUBLISHMESSAGES=true -e CLUSTERING_LOGLEVEL=info ${docker_image}:${harperdb_version}

sleep 30s

# Install newman and newman reporters on first container
sudo docker exec ClstrTestA1 /bin/bash -c 'cat /home/harperdb/hdb/harperdb-config.yaml| grep nodeName'
sudo docker exec ClstrTestA1 /bin/bash -c 'npm install -g newman newman-reporter-teamcity newman-reporter-html newman-reporter-htmlextra'

# modify integrationTests folder before copy
sed -in "s/ClstrTestANode1/ClstrTestA1/" integrationTests/clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestANode2/ClstrTestA2/" integrationTests/clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestANode3/ClstrTestA3/" integrationTests/clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestANode4/ClstrTestA4/" integrationTests/clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ClstrTestANode5/ClstrTestA5/" integrationTests/clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json
sed -in "s/ubuntu/harperdb/" integrationTests/clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json

# Copy integrationTests folder to first container
sudo docker exec ClstrTestA1 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker cp integrationTests/ ClstrTestA1:/home/harperdb/harperdb/

# Copy test folder to containers
sudo docker exec ClstrTestA1 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker exec ClstrTestA2 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker exec ClstrTestA3 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker exec ClstrTestA4 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker exec ClstrTestA5 /bin/bash -c 'mkdir /home/harperdb/harperdb/'
sudo docker cp test/ ClstrTestA1:/home/harperdb/harperdb/
sudo docker cp test/ ClstrTestA2:/home/harperdb/harperdb/
sudo docker cp test/ ClstrTestA3:/home/harperdb/harperdb/
sudo docker cp test/ ClstrTestA4:/home/harperdb/harperdb/
sudo docker cp test/ ClstrTestA5:/home/harperdb/harperdb/

# Run cluster tests from first container
sudo docker exec --user root ClstrTestA1 /bin/bash -c 'mkdir -p ~/harperdb/integrationTests/newman && chmod 777 ~/harperdb/integrationTests/newman'
sudo docker exec ClstrTestA1 /bin/bash -c 'cd ~/harperdb/integrationTests/ && newman run clusterTests/clusterTestA/Five_Node_Cluster.postman_collection.json -e clusterTests/clusterTestA/Five_node_cluster_tests_env_var.postman_environment.json --reporters teamcity,cli,html,htmlextra --reporter-html-export newman/report.html --reporter-htmlextra-export newman/extra_report.html  --delay-request 1000 --insecure --reporter-cli-show-timestamps'
test_status=$?

artifact_dir="artifact"
mkdir -p $artifact_dir/ClstrTestA1/
mkdir -p $artifact_dir/ClstrTestA2/
mkdir -p $artifact_dir/ClstrTestA3/
mkdir -p $artifact_dir/ClstrTestA4/
mkdir -p $artifact_dir/ClstrTestA5/

# Copy log and config files from containers
sudo docker cp --follow-link ClstrTestA1:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestA1/
sudo docker cp --follow-link ClstrTestA2:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestA2/
sudo docker cp --follow-link ClstrTestA3:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestA3/
sudo docker cp --follow-link ClstrTestA4:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestA4/
sudo docker cp --follow-link ClstrTestA5:/home/harperdb/hdb/harperdb-config.yaml $artifact_dir/ClstrTestA5/
sudo docker cp --follow-link ClstrTestA1:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestA1/
sudo docker cp --follow-link ClstrTestA2:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestA2/
sudo docker cp --follow-link ClstrTestA3:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestA3/
sudo docker cp --follow-link ClstrTestA4:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestA4/
sudo docker cp --follow-link ClstrTestA5:/home/harperdb/hdb/log/ $artifact_dir/ClstrTestA5/

# Capture sudo docker logs
sudo docker logs ClstrTestA1 > $artifact_dir/ClstrTestA1/docker_log.log
sudo docker logs ClstrTestA2 > $artifact_dir/ClstrTestA2/docker_log.log
sudo docker logs ClstrTestA3 > $artifact_dir/ClstrTestA3/docker_log.log
sudo docker logs ClstrTestA4 > $artifact_dir/ClstrTestA4/docker_log.log
sudo docker logs ClstrTestA5 > $artifact_dir/ClstrTestA5/docker_log.log

# Capture newman reports
sudo docker cp --follow-link ClstrTestA1:/home/harperdb/harperdb/integrationTests/newman/report.html $artifact_dir
sudo docker cp --follow-link ClstrTestA1:/home/harperdb/harperdb/integrationTests/newman/extra_report.html $artifact_dir

# Chown so we can scp
sudo chown -R ubuntu:ubuntu $artifact_dir 

exit $test_status