#!/bin/bash

#REMOVE FOR PRODUCTION
#sed -i "/HDB_PROC_NAME/ s/ =.*/ = 'no_oneis_here';/" /opt/harperdb/bin/run.js
#sed -i "s/\#\!\/usr\/bin\/env node//" /opt/harperdb/bin/run.js
#sed -i "s/\#\!\/usr\/bin\/env node//" /opt/harperdb/bin/stop.js
#Change into each Directory generate an array of the Javascript; js_files
#Itterate through js_files, Obfuscate each file send output to file mirrored HarperDB directory; mirrored_dir
#Change directory back to this scripts working directory to prepare for next directory; working_dir
#
#The mirrored File structure is recreated and cleaned
#Then add newly obfuscated files through the --output option in javascript-obfuscator command.

#Files to search for javascript to obfuscate as of 12/17/2018.. Please keep this updated!!(should Upgrade to new version functionality;
#now allows directory use 
#version i was using only allowed individual .js files at a time.)

files=( "data_layer" "sqlTranslator" "validation" "security" "utility" "utility/install" "utility/logging" "utility/functions" "utility/functions/date" "utility/functions/math" "utility/functions/string" "utility/functions/sql" "utility/registration" "lib/fileSystem" "lib/server" "lib/streams" "server" "server/clustering" "json" "bin")

working_dir="$(pwd)/../../";
mirrored_dir="/tmp/harperdb_dev"
echo "here i am $working_dir"
echo "stuff: $(ls $working_dir)"
mkdir -p $mirrored_dir;
rm -rf $mirrored_dir/*

echo "Working directory: $working_dir"
echo "**Create mirrored dir $mirrored_dir"
cp -R $working_dir/* $mirrored_dir

#clean up unwanted directories for executable only
cd $mirrored_dir
rm -rf ./integrationTests ./test ./unitTests ./user_guide.html ./bash ./package-lock.json
############################

cd $working_dir
#Loop through files[] array and get js files to obfuscate.
echo "**Copy complete to mirrored dir**  $(ls $mirrored_dir)"
for i in "${files[@]}"
do
echo "**Cleaning Mirrored dir $mirrored_dir/$i/"
   rm -rf $mirrored_dir/$i/*.js
echo "**Cleaned**  $(ls $mirrored_dir/$i)"
   cd $working_dir/$i/

echo "Directory now in Array: $(pwd)"

   js_files=( $( ls ./ | grep -E \.js$ ) )
echo "js array files: ${js_files[@]}"

   for z in "${js_files[@]}"
   do
echo "The javascript file to obfuscate: $z"
      javascript-obfuscator $z --compact true --controlFlowFlattening false --deadCodeInjection false --debugProtection false --debugProtectionInterval false \
           --disableConsoleOutput false --log false --renameGlobals false --rotateStringArray false --selfDefending true --stringArray false --stringArrayEncoding false \
           --stringArrayThreshold 0.75 --unicodeEscapeSequence false --output $mirrored_dir/$i/$z
echo "done obfuscating $z"
   done

   cd $working_dir
done
sed -i "1s/^/\#\!\/usr\/bin\/env node\n/" $mirrored_dir/bin/harperdb.js

