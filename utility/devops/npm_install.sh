#!/usr/bin/env bash

pkgJsonName=$(npm version | grep harperdb | awk '{print $2}' | tr -d \:)
pkgJsonVersion=$(npm version | grep harperdb | awk '{print $3}' | tr -d \'\,)
installME=$(ls harperdb-*)
#"$pkgJsonName-$pkgJsonVersion.tgz"
pwd
echo "NPM INstall $installME"
sudo -E npm remove -g harperdb
npm -f pack
sudo -E npm install -g ./$installME


#Version check
echo "HarperDB version check"
harperdb version

rm -rf /home/ubuntu/ci_test
rm -rf $(pwd)/hdb

mkdir /home/ubuntu/ci_test
cd /home/ubuntu/ci_test
harperdb install --TC_AGREEMENT yes --HDB_ROOT $(pwd)/hdb --HTTP_PORT 9925 --HTTPS_PORT 31283 --HDB_ADMIN_USERNAME admin --HDB_ADMIN_PASSWORD "Abc1234!"

   sleep 3s

   harperdb run
      sleep 3s
      theProc=$(ps -ef | grep [h]db_express)
      thePort=$(ss -tln | grep 9925)
      echo "The processes: $theProc"
      echo "HarperDB is running on port: $thePort"


