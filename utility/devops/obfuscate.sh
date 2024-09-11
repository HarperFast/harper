#!/bin/bash
#Excludes from obfuscation
EXCLUDE="docs,json,integrationTests,node_modules,unitTests,./test,./utility/devops"
#ADD directories and files required for running and downstream tests
ADD="node_modules/ integrationTests/ json/ package.json .eslintrc.json"
ADD_PROD="json/ .eslintrc.json"

#ADD2_DIR is path for ADD2 misc files for running harperdb.
ADD2_DIR="utility/install"
ADD2="$ADD2_DIR/ascii_logo.txt $ADD2_DIR/harperdb-config.yaml $ADD2_DIR/harperdb.service"

#mirrored dir for obfucation output
if [[ ! "$HDB_PROD" || -z "$HDB_PROD" ]]; 
   then
      MIRRORED_DIR="/tmp/harperdb_dev"	   
   else
     MIRRORED_DIR="/tmp/harperdb_prod" 
fi

#OBfuscator fails on #!/.. remove then add back at the end
sed -i 's/#!\/usr\/bin\/env node//' ./bin/harperdb.js

javascript-obfuscator ./ --exclude "$EXCLUDE" -c ./utility/devops/obfuscate_config.json -o $MIRRORED_DIR

#Copy some required files to the mirrored dir.
#IFF NOT PROD add these files for testing.
if [[ ! "$HDB_PROD" || -z "$HDB_PROD" ]]; then
   {
	
      cp -R $ADD $MIRRORED_DIR
      mkdir $MIRRORED_DIR/utility/devops
      cp utility/devops/* $MIRRORED_DIR/utility/devops/
   }
fi

cp $ADD2 $MIRRORED_DIR/$ADD2_DIR
mkdir -p $MIRRORED_DIR/dependencies/harperdb_helium/build/Release
mkdir -p $MIRRORED_DIR/dependencies/harperdb_helium/mac/build/Release
cp ./dependencies/harperdb_helium/build/Release/* $MIRRORED_DIR/dependencies/harperdb_helium/build/Release/
cp ./dependencies/harperdb_helium/mac/build/Release/* $MIRRORED_DIR/dependencies/harperdb_helium/mac/build/Release/
cp ./npm_build/package.json $MIRRORED_DIR/
cp ./npm_buil/README.md $MIRRORED_DIR/

#create file for registration process
#mkdir $MIRRORED_DIR/utility/keys
#Add the removed header for harperdb.js
sed -i '1 i #!\/usr\/bin\/env node' $MIRRORED_DIR/bin/harperdb.js
exit 0
