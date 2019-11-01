#!/usr/bin/env bash
cd ~/WebstormProjects/harperdb/

#move node_modules out so it the js files do not get renamed
mv node_modules ~/Apps/

#rename all *.jj files to *.js, this is to bring our source back
find . -name "*.jj" -exec rename 's/\.jj$/\.js/i' {} \;

#delete all *.jsc files to have a clean build
find -type f -name '*.jsc' -delete

#start compiling
bytenode --compile bin/*.js

bytenode --compile data_layer/*.js
bytenode --compile data_layer/**/*.js
bytenode --compile data_layer/**/**/*.js
bytenode --compile data_layer/**/**/**/*.js

bytenode --compile dependencies/harperdb_helium/*.js

bytenode --compile events/*.js

bytenode --compile lib/**/*.js

bytenode --compile security/*.js

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
bytenode --compile utility/helium/*.js
bytenode --compile utility/logging/*.js
bytenode --compile utility/registration/*.js
bytenode --compile utility/userInterface/*.js

bytenode --compile validation/*.js
bytenode --compile validation/**/*.js

#rename our source *.js files to *.jj so they do not interact with code
find . -name "*.js" -exec rename 's/\.js$/\.jj/i' {} \;

#bring the node modules back
mv ~/Apps/node_modules ./

mv ./bin/harperdb_jsc.jj ./bin/harperdb.js
unlink ./bin/harperdb_jsc.jsc

mv ./upgrade/scripts/postInstall_jsc.jj ./upgrade/scripts/postInstall.js
unlink ./upgrade/scripts/postInstall_jsc.jsc
