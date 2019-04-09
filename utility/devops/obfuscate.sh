#!/bin/bash
#hdb_data="/root/hdb"
EXCLUDE="docs,json,integrationTest,node_modules,unitTests,test,utility/devops"
ADD="node_modules/ integrationTest/ json/"
MIRRORED_DIR="/tmp/harperdb_dev"

#REMOVE FOR PRODUCTION
sed -i "/HDB_PROC_NAME/ s/ =.*/ = 'no_oneis_here';/" /opt/harperdb/bin/run.js
#NOTE: CREATE JIRA FOR DEV team to remove #!
sed -i "s/#.*//" /bin/stop.js

#Copy some required files to the mirrored dir.
cp -R $ADD $MIRRORED_DIR

javascript-obfuscator ./ --exclude "$EXCLUDE" -c ./utility/devops/obfuscate_config.json -o $MIRRORED_DIR

