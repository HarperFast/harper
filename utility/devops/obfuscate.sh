#!/bin/bash
#Excludes from obfuscation
EXCLUDE="docs,json,integrationTests,node_modules,unitTests,test utility/devops"
#ADD directories and files required for running and downstream tests
ADD="node_modules/ integrationTests/ json/ package.json"
#ADD2_DIR is path for ADD2 misc files for running harperdb.
ADD2_DIR="utility/install"
ADD2="$ADD2_DIR/ascii_logo.txt $ADD2_DIR/harperdb.conf $ADD2_DIR/harperdb.service"

#mirrored dir for obfucation output
MIRRORED_DIR="/tmp/harperdb_dev"

#REMOVE FOR PRODUCTION
sed -i "/HDB_PROC_NAME/ s/ =.*/ = 'no_oneis_here';/" ./bin/run.js
#NOTE: CREATE JIRA FOR DEV team to remove #!
sed -i "s/#.*//" ./bin/stop.js

javascript-obfuscator ./ --exclude "$EXCLUDE" -c ./utility/devops/obfuscate_config.json -o $MIRRORED_DIR

#Copy some required files to the mirrored dir.
cp -R $ADD $MIRRORED_DIR
cp $ADD2 $MIRRORED_DIR/$ADD2_DIR
mkdir $MIRRORED_DIR/utility/devops
cp utility/devops/* $MIRRORED_DIR/utility/devops/
