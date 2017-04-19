#!/usr/bin/env bash
#!/bin/bash

table_path=$1
staging_path=$2
search_field=$3
ls_regex=$4
awk_regex=${ls_regex//\*/}
IFS=',' read -r -a attributes <<< "$5"
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

. ${DIR}/lib/searchHDB.sh

ids=($(searchHDB ))

. ${DIR}/lib/awkFiles.sh