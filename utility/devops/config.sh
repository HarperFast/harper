#!/bin/bash
script_home=$(pwd)
mv $script_home/node_modules/@harperdb/settings/ $script_home/node_modules/settings

#echo $script_home
sed -ie "/HDB_ADDRESS/ s:\:.*:\:\'0\.0\.0\.0\':" $script_home/settings.js 
sed -ie "/HDB_ROOT/ s:__dirname.*:\'$(find /opt -name hdb)\',:" $script_home/settings.js
