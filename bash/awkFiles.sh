#!/usr/bin/env bash
#!/bin/bash

table_path=$1
shift
staging_path=$1
shift
IFS=',' read -r -a attributes <<< "$1"
shift
ids=($@)
ids=( "${ids[@]/%/.hdb}" )
data_file_array=()
time=`date +%s%N`

awkFiles() {
    attribute="$1"
    file="$2"
    cd "${table_path}${attribute}/__hdb_hash"
    shift

    awk -v file="$file" 'function basename(file, a, n) {
            n = split(file, a, "/")
            return a[n]
        }
        BEGIN{ORS="," }
        BEGINFILE { if (ERRNO != "")
            {
                print "\""FILENAME"\":null" > file; nextfile;
            }
        }
        {print "\""FILENAME "\":\"" $0"\"" > file}' ${ids[@]}

}

for i in "${attributes[@]}"
do
    file="${staging_path}${i}.${time}.txt"
    data_file_array+=($file)
    awkFiles $i $file &
done

wait

printf '%s\n' "${data_file_array[@]}"