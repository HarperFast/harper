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


DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

. ${DIR}/lib/awkFiles.sh