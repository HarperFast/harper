#!/bin/bash
hdb_data=$(pwd)
    
	hdb_express_route=$(pwd)
	cd ./bin/
	#incase harperdb is running for another reason
	sed -i "s/HDB_PROC_NAME =.*/HDB_PROC_NAME = 'no_one_here';/" run.js
	
	node harperdb install --TC_AGREEMENT yes --HDB_ROOT $hdb_data/hdb --HTTP_PORT 9925 --HTTPS_PORT 31283 --HDB_ADMIN_USERNAME admin --HDB_ADMIN_PASSWORD "Abc1234!"
	
	node harperdb run
	
#theProc checks to make sure this specific instance of harperdb is running.
#grep -v grep makes sure theProc does not get the value of the grep process that is being used to grep the harperdb proccess.
	theProc=$(ps -ef | grep $hdb_express_route/server/hdb_express | grep -v grep);

	if [ "$theProc" ]; then
		 					
		echo "HarperDB started"
		echo "Stopping"
	
		node harperdb stop
	    
		stopped=$(ps -ef | grep $hdb_express_route/server/hdb_express | grep -v grep)
#Check variable stop is empty		
		if [ -z "$stopped" ]; then
		 					
		   echo "HarperDB stopped";
		   echo "Success!!"
                   echo "Check Logs for Errors"
#grep error values in install_log.log
                   the_errors=$(grep "\"level\":\"error\"" ./../install_log.log)
                   pico_errors=$(grep "\"level\":\"50\"" ./../install_log.log) 
#Check variable error for errors                   
                   if [ "$the_errors" ] || [ "$pico_errors" ] ; then
		       echo "ERRORS FOUND"
		       echo "$the_errors"
                       echo "$pico_errors"
		   fi
#remove hdb/ dir and hdb_ files
                   echo "Clean up"
                   rm -rf ../hdb_* ../hdb/ 
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
