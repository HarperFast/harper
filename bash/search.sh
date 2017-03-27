#!/usr/bin/env bash
#find /Users/stephengoldberg/Projects/harperdb/hdb/schema/dev/person/last_name -name '1.hdb' -mmin -2000
FILE=$1
if [ -d $FILE ]; then
   echo "true"
else
   echo "false"
fi