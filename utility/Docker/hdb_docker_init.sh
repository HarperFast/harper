#!/bin/bash

hdb_existance=$(ls /opt/harperdb/hdb/)
if [ -z "$hdb_existance" ];
then
	echo "There is not an existing install. Initializing data directory."
   rsync -r /home/node/hdb_tmp/* /opt/harperdb/hdb/
   rm -rf /home/node/hdb_tmp/*
fi
/usr/local/bin/harperdb foreground

