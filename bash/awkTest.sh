#!/usr/bin/env bash

cd /home/kyle/hdb/schema/dev/person/last_name
#sample="awk '{print}' __hdb_hash/{1,66,3,55,92,2365,754}.hdb"
#eval $sample

#files=($(find -path './C*' -name '*.hdb' -printf "/__hdb_hash/%f\n" | uniq))
#echo ${files[@]}
#awk 'BEGINFILE { if (ERRNO != ""){ print "null\n" FILENAME ; nextfile;}}{print FILENAME ":" $0}' */'^A'/*.hdb  #*/__hdb_hash/2.hdb */__hdb_hash/3.hdb */__hdb_hash/4.hdb */__hdb_hash/5.hdb
#find 'Cindy'
#files=($(find ./ -name '^Cindy')) #-exec awk '{print}' {} \;


awk 'BEGINFILE { if (ERRNO != ""){ print "null\n" FILENAME ; nextfile;}}{print FILENAME ":" $0}' $(find -path './*' -name '*.hdb' -printf "%h%f ")
#awk 'BEGINFILE { if (ERRNO != ""){ print "null\n" FILENAME ; nextfile;}}{print FILENAME ":" $0}' $(find -path './*' -name '*.hdb' -printf "../first_name/__hdb_hash/%f " | uniq)