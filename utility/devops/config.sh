#!/bin/bash
script_home=$(pwd)
#echo $script_home
sed -ie "/HDB_ADDRESS/ s:\:.*:\:\'0\.0\.0\.0\':" $script_home/settings.js 
sed -ie "/HDB_ROOT/ s:__dirname.*:\'$(find /opt -name hdb)\',:" $script_home/settings.js
mv ./node_modules/@harperdb/settings ./node_modules/settings
