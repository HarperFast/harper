#!/bin/bash

#Determine if we need to move harperdb

#check if mount path is empty
hdb_existance=$(ls /opt/harperdb/hdb/)

if [ -z "$hdb_existance" ];
then
	echo "There is not an existing install. Initializing data directory."
#IFF hdb is empty it does NOT exist, copy installed container hdb to mount path
   rsync -r /home/node/hdb_tmp/* /opt/harperdb/hdb/
#Remove duplicate
   rm -rf /home/node/hdb_tmp/*
fi
#Start HarperDB
/usr/local/bin/harperdb foreground

