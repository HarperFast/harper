#!/bin/bash
#Excludes from obfuscation
EXCLUDE="docs,json,integrationTests,node_modules,unitTests,test,utility/devops"
#ADD directories and files required for running and downstream tests
ADD="node_modules/ integrationTests/ json/ package.json .eslintbuild .eslintrc.json"
#ADD2_DIR is path for ADD2 misc files for running harperdb.
ADD2_DIR="utility/install"
ADD2="$ADD2_DIR/ascii_logo.txt $ADD2_DIR/harperdb.conf $ADD2_DIR/harperdb.service"

#mirrored dir for obfucation output
MIRRORED_DIR="/tmp/harperdb_dev"

#OBfuscator fails on #!/.. remove then add back at the end
sed -i 's/#!\/usr\/bin\/env node//' ./bin/harperdb.js
#REMOVE FOR PRODUCTION
sed -i "s/HDB_PROC_NAME =.*/HDB_PROC_NAME='NoOne';/1" utility/common_utils.js
#NOTE: CREATE JIRA FOR DEV team to remove #!
#sed -i "s/#.*//" ./bin/stop.js

javascript-obfuscator ./ --exclude "$EXCLUDE" -c ./utility/devops/obfuscate_config.json -o $MIRRORED_DIR

#Copy some required files to the mirrored dir.
cp -R $ADD $MIRRORED_DIR
cp $ADD2 $MIRRORED_DIR/$ADD2_DIR
mkdir $MIRRORED_DIR/utility/devops
cp utility/devops/* $MIRRORED_DIR/utility/devops/
#create file for registration process
mkdir $MIRRORED_DIR/utility/keys
#Add the removed header for harperdb.js
sed -i '1 i #!\/usr\/bin\/env node' $MIRRORED_DIR/bin/harperdb.js
