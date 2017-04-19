#!/usr/bin/env bash
#!/bin/bash

data_file_array=()
thedate=`date +%Y-%m-%d`
time=`date +%H:%M:%S.%N`

awkFiles() {
    attribute="$1"
    file="$2"
    cd "${table_path}${attribute}/__hdb_hash"
    shift
    mkdir -p ${staging_path}${thedate}
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
    file="${staging_path}${thedate}/${i}.${time}.txt"
    data_file_array+=($file)
    awkFiles $i $file &
done

wait

printf '%s\n' "${data_file_array[@]}"