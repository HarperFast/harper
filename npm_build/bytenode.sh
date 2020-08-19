echo "Bytenode compile"
#start compiling
bytenode --compile bin/*.js

bytenode --compile data_layer/*.js
bytenode --compile data_layer/**/*.js
bytenode --compile data_layer/**/**/*.js
bytenode --compile data_layer/**/**/**/*.js

bytenode --compile events/*.js

bytenode --compile lib/**/*.js

bytenode --compile security/*.js
bytenode --compile security/data_model/*.js

bytenode --compile server/*.js
bytenode --compile server/**/*.js
bytenode --compile server/**/**/*.js
bytenode --compile server/**/**/**/*.js

bytenode --compile sqlTranslator/*.js

bytenode --compile upgrade/*.js
bytenode --compile upgrade/**/*.js

bytenode --compile utility/*.js
bytenode --compile utility/environment/*.js
bytenode --compile utility/fs/*.js
bytenode --compile utility/functions/*.js
bytenode --compile utility/functions/**/*.js
bytenode --compile utility/install/*.js
bytenode --compile utility/lmdb/*.js
bytenode --compile utility/logging/*.js
bytenode --compile utility/registration/*.js
bytenode --compile utility/userInterface/*.js
bytenode --compile utility/errors/*.js

bytenode --compile validation/*.js
bytenode --compile validation/**/*.js


mv ./bin/harperdb_jsc.js ./bin/harperdb.js
unlink ./bin/harperdb_jsc.jsc

mv ./upgrade/scripts/postInstall_jsc.js ./upgrade/scripts/postInstall.js
unlink ./upgrade/scripts/postInstall_jsc.jsc


echo "******** Compile Complete *************"
rsync --include="*.jsc" --include="harperdb.js" --include="processCSV.worker.js" --exclude="*.js" --exclude=".*" --recursive ./ /tmp/harperdb_dev/
echo "*********** RSYNC COMPLETE *************"
cd /tmp/harperdb_dev/
rm -rf ./utility/devops ./test ./unitTests ./integrationTests ./bash ./upgrade_shim ./utility/Docker ./user_guide.html ./sonar-project.properties
