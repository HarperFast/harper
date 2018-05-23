#!/bin/bash
hdb_data=$(pwd)
    
	hdb_express_route=$(pwd)
	cd ./bin/
	#incase harperdb is running for another reason
	sed -i "s/HDB_PROC_NAME =.*/HDB_PROC_NAME = 'no_one_here';/" run.js
	
	node harperdb install --TC_AGREEMENT yes --HDB_ROOT $hdb_data/hdb --HTTP_PORT 9925 --HTTPS_PORT 31283 --HDB_ADMIN_USERNAME admin --HDB_ADMIN_PASSWORD "Abc1234!"
	
	node harperdb run
	
	theProc=$(ps -ef | grep $hdb_express_route/server/hdb_express | grep -v grep);

	if [ "$theProc" ]; then
		 					
		echo "HarperDB started"
		echo "Stopping"
	
		node harperdb stop
	    
		stopped=$(ps -ef | grep $hdb_express_route/server/hdb_express | grep -v grep)
		
		if [ -z "$stopped" ]; then
		 					
		   echo "HarperDB stopped";
		   echo "Success!!"
                   echo "clean up"
                   rm -rf ../hdb_* ../install_* ../hdb/ 
                   sed -i "s/HDB_PROC_NAME =.*/HDB_PROC_NAME = 'hdb_express.js';/" run.js
                   echo "Exit 0"
		   exit 0;
                fi
	else
		echo "HarperDB did not start?"
		# clean Up install artifacts.
		rm -f ../hdb_* ../install_*
		rm -r ../$hdb_data
                 sed -i "s/HDB_PROC_NAME =.*/HDB_PROC_NAME = 'hdb_express.js';/" run.js
		echo "Failed"
		exit 1;
	fi
echo "Something is wrong. good bye."
	exit 1;
