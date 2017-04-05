#!/bin/bash

#cd into the table folder i.e. home/hdb/schema/dev/person
cd $1
delimiter='~hdb~'

#advances the arguments forward one index so we can iterate all of the passed in file names
shift

#check if the file exists with the beginfile function, delimit file results with our delimiter variable
awk -v delim="$delimiter" 'BEGINFILE { if (ERRNO != ""){ print "null\n" delim; nextfile;}}{print} ENDFILE{print delim}' $@