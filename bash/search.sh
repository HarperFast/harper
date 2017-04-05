#!/usr/bin/env bash
#!/bin/bash
#file_paths=( 'first_name/__hdb_hash/1.hdb' 'last_name/__hdb_hash/1.hdb' 'first_name/__hdb_hash/2.hdb' 'last_name/__hdb_hash/2.hdb' 'first_name/__hdb_hash/3.hdb' 'last_name/__hdb_hash/3.hdb' 'first_name/__hdb_hash/4.hdb' 'last_name/__hdb_hash/4.hdb' 'first_name/__hdb_hash/5.hdb' 'last_name/__hdb_hash/5.hdb' 'first_name/__hdb_hash/6.hdb' 'last_name/__hdb_hash/6.hdb');

cd /home/stephen/Webshdb/schema/dev/person/
delimiter='~hdb~'


awk -v delim="$delimiter" 'BEGINFILE { if (ERRNO != ""){ print "null\n" delim; nextfile;}}{print $0} ENDFILE{print delim}' 'first_name/__hdb_hash/1.hdb' 'last_name/__hdb_hash/1.hdb'