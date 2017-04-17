#!/usr/bin/env bash
#!/bin/bash

#cd /home/stephen/Webshdb/schema/dev/person/
#delimiter='~hdb~'
#
#
#awk -v delim="$delimiter" 'BEGINFILE { if (ERRNO != ""){ print "null\n" delim; nextfile;}}{print $0} ENDFILE{print delim}' 'first_name/__hdb_hash/1.hdb' 'last_name/__hdb_hash/1.hdb'

table_path=$1
staging_path=$2
search_field=$3
ls_regex=$4
awk_regex=$5
IFS=',' read -r -a attributes <<< "$6"
ids=()
data_file_array=()
time=`date +%s%N`

searchHDB () {
    cd "${table_path}${search_field}"
    ls_search="./${ls_regex}/"

    files=($(find $ls_search -maxdepth 1 -mindepth 1 -type l  -printf "%l\n" | sort | uniq | awk '{sub(/..\//, "./"); print}'))
    array_length=${#files[@]}

    if [ $array_length -gt 0 ]
    then
        awk -v search="$awk_regex" 'function basename(file, a, n) {
            n = split(file, a, "/")
            return a[n]
        } {if (match($0, search)) print basename(FILENAME) }' ${files[@]}
    else
        echo ${files[@]}
    fi
}

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

ids=($(searchHDB ))

for i in "${attributes[@]}"
do
    file="${staging_path}${i}.${time}.txt"
    data_file_array+=($file)
    awkFiles $i $file &
done

wait

printf '%s\n' "${data_file_array[@]}"