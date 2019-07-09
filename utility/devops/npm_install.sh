#!/usr/bin/env bash

#Prepare package.json for publishing.
#sed -i 's/\"name\":.*/\"name\": \"@harperdb\/testing\"/' package.json
#sed -i 's/\"version\":.*/\"version\": \"0.0.1\"/' package.json

#Publish to npm, ci server uses global /usr/etc/npmrc file for login
#npm publish ./ --access restricted

#Remove existing possible installs.
#echo "npm remove private package @harperdb/harperdb_ci_test"
#sudo npm remove @harperdb/harperdb_ci_test

#Install private npm @harperdb/harperdb_ci_test@0.0.1
#echo "npm install @harperdb/harperdb_ci_test@0.0.1"
#sudo -E npm install -g @harperdb/harperdb_ci_test@0.0.1

#Version check
echo "HarperDB version check"
harperdb version

rm /home/ubuntu/ci_test
mkdir /home/ubuntu/ci_test
cd /home/ubuntu/ci_test
harperdb install --TC_AGREEMENT yes --HDB_ROOT $(pwd)/../hdb --HTTP_PORT 9925 --HTTPS_PORT 31283 --HDB_ADMIN_USERNAME admin --HDB_ADMIN_PASSWORD "Abc1234!"

   sleep 3s

   node harperdb run
      sleep 3s
      theProc=$(ps -ef | grep [h]db_express)
      thePort=$(ss -tln | grep 9925)
      echo "The processes: $theProc"
      echo "HarperDB is running on port: $thePort"


