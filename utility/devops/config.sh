#!/bin/bash
script_home=$(pwd)
mv $script_home/node_modules/@harperdb/settings/ $script_home/node_modules/settings
rm -rf $script_home/node_modules/@harperdb
#echo $script_home
sed -ie "/PROJECT_DIR/ s:\:.*:\: \'$script_home\',:" $script_home/settings.js
sed -ie "/HDB_ADDRESS/ s:\:.*:\: \'0\.0\.0\.0\',:" $script_home/settings.js
sed -ie "/HDB_ROOT/ s:\:.*:\: \'$(find /opt -maxdepth 4 -name hdb)\',:" $script_home/settings.js
