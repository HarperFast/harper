#!/bin/bash
HDB_DATA=$(pwd)

cd ./bin/
echo "I am in this directory now: $(pwd)"
node harperdb install --TC_AGREEMENT yes --HDB_ROOT $(pwd)/../hdb --HTTP_PORT 9925 --HTTPS_PORT 31283 --HDB_ADMIN_USERNAME admin --HDB_ADMIN_PASSWORD "Abc1234!"

   sleep 3s    

node harperdb run
   sleep 3s
theProc=$(ps -ef | grep [h]db_express)
thePort=$(ss -tln | grep 9925)
echo "The processes: $theProc"
echo "HarperDB is running on port: $thePort"



