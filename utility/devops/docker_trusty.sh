#!/bin/bash
hdb_data="/root/hdb"
obfuscript()
{
#Change into each Directory generate an array of the Javascript; js_files
#Itterate through js_files, Obfuscate each file send output to file mirrored HarperDB directory; mirrored_dir
#Change directory back to this scripts working directory to prepare for next directory; working_dir
#
#The mirrored File structure is recreated and cleaned
#Then add newly obfuscated files through the --output option in javascript-obfuscator command.

#Files to search for javascript to obfuscate as of 9/1/2017.. Please keep this updated!! updated 9-29-2017 added utility/* lib/ server/
# "data_layer" "sqlTranslator" "validation" "security" "utility" "utility/logging"

files=( "data_layer" "sqlTranslator" "validation" "security" "utility" "utility/install" "utility/logging" "utility/functions/date" "utility/functions/math" "lib/fileSystem" "lib/server" "lib/streams" "server")
working_dir="$(pwd)/../../";
mirrored_dir="/tmp/harperdb"
echo "here i am $working_dir"
echo "stuff: $(ls $working_dir)"
mkdir -p $mirrored_dir;
rm -rf $mirrored_dir/*

echo "Working directory: $working_dir"
echo "**Create mirrored dir $mirrored_dir"
cp -R $working_dir/* $mirrored_dir
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
           --disableConsoleOutput false --log false --mangle true --renameGlobals false --rotateStringArray false --selfDefending true --stringArray false --stringArrayEncoding false \
           --stringArrayThreshold 0.75 --unicodeEscapeSequence false --output $mirrored_dir/$i/$z
echo "done obfuscating $z"
   done

   cd $working_dir
done

}
harperdb_run()
{
#this function is being run on a docker container as root.  Be advised of the paths.
     cd ./bin/
     echo "I am in this directory now: $(pwd)"
     ./linux-harperdb run --HDB_ROOT $hdb_data --HTTP_PORT 9925 --HTTPS_PORT 31283 --HDB_ADMIN_USERNAME admin --HDB_ADMIN_PASSWORD "Abc1234!"
    sleep 7s    
    theProc=$(ps -ef | grep [h]db_express);

        if [ "$theProc" ];
           then
    apiKey=fe1dfb2c3647474f8f3e9d836783e694
#mycos Collection
    collection_id=45f26d10-5af1-3f5d-b00b-a39a52c9aa45    

#zach's dummy tests
#collection_id=b21ee620-6c69-7566-9a11-e2ce6ece23cd

#mycos Environment 
    environment_id=65398310-b319-fc53-7f6c-78710804cda3

#zach's dummmy environment 
#environment_id=d4f6eefe-b922-9888-043f-43a374a1ef1a

    newman run https://api.getpostman.com/collections/$collection_id?apikey=$apiKey \
    --environment https://api.getpostman.com/environments/$environment_id?apikey=$apiKey -r cli > ../newman_output.log 2> ../error.out
   
./linux-harperdb stop
       else
           echo "Process hdb_express did not start?"
           #clean Up install artifacts.
                rm -f ../hdb_* ../install_*
                rm -r $hdb_data/*
                echo "WTF am I: $hdb_data"
           exit 1;
        fi
exit 0
}

newman_output(){
echo "I am in this directory now looking for newman_output.log: $(pwd)"
#Grabbing the Newman cli output and grep the stream of the failures, if any occurred.
    cat newman_output.log
    theFailed=$(cat newman_output.log | grep -A 10 "#  failure")

    if [ "$theFailed" ];
     then
        echo "Failed NewMan Tests"
        echo $theFailed
        exit 1;
    fi
    
    if [ -s error.out ]
       then
          echo "Some error in newman process!"
          newman_err=$(cat error.out)
          echo "New man errors: $newman_err"
          exit 1
    fi

exit 0
}

cleanup(){
cd ./bin/

./linux-harperdb stop
#clean Up install artifacts.
                rm -f ../hdb_* ../install_*
                rm -rf $hdb_data/*


              exit 0;


}

$@
