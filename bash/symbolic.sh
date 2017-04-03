#!/usr/bin/env bash

cd /home/kyle/hdb/schema/dev/person/

printf "{\"id\":1,\"first_name\":\"Sally\",\"last_name\":\"Medina\"}" > id/1/1-1490978268398.hdb

if [ -f first_name/__hdb_hash/1.hdb ]; then
    rm `readlink first_name/__hdb_hash/links/1_link21321.hdb`

    #rm -f `find /home/kyle/hdb/schema/dev/person/first_name -lname /home/kyle/hdb/schema/dev/person/first_name/__hdb_hash/1.hdb`
    #mv -f -t /home/kyle/hdb/schema/dev/person/first_name/Sally `find /home/kyle/hdb/schema/dev/person/first_name -lname /home/kyle/hdb/schema/dev/person/first_name/__hdb_hash/1.hdb -not -path */Sally/*`
fi
printf "Sally" > first_name/__hdb_hash/1.hdb;
ln -sf /home/kyle/hdb/schema/dev/person/first_name/__hdb_hash/1.hdb ./first_name/Sally/1.hdb
printf first_name/Sally/1.hdb >> ./first_name/__hdb_hash/links/1.hdb

if [ -f last_name/__hdb_hash/1.hdb ]; then
    rm `readlink last_name/__hdb_hash/links/1_link21321.hdb`

    #rm -f `find /home/kyle/hdb/schema/dev/person/last_name -lname /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb`
    #mv -f -t /home/kyle/hdb/schema/dev/person/last_name/Sally `find /home/kyle/hdb/schema/dev/person/last_name -lname /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb -not -path */Sally/*`
fi
printf "Medina" > last_name/__hdb_hash/1.hdb;
ln -sf /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb ./last_name/Medina/1.hdb
ln -sf /home/kyle/hdb/schema/dev/person/last_name/Medina/1.hdb ./last_name/__hdb_hash/links/1_link21321.hdb

#if [ -f last_name/__hdb_hash/1.hdb ]; then
#    rm -f `find /home/kyle/hdb/schema/dev/person/last_name -lname /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb`
#    #mv -f -t /home/kyle/hdb/schema/dev/person/last_name/Medina `find /home/kyle/hdb/schema/dev/person/last_name -lname /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb -not -path */Medina/*`
#fi
#printf "Medina" > last_name/__hdb_hash/1.hdb;
#ln -sf /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb ./last_name/Medina/1.hdb

#if [ -f last_name/__hdb_hash/1.hdb ]; then
#    printf "Medina" > last_name/__hdb_hash/1.hdb;
#    mv -f -t /home/kyle/hdb/schema/dev/person/last_name/Medina `find /home/kyle/hdb/schema/dev/person/last_name -lname /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb -not -path */Medina/*`
#else
#    printf "Medina" > last_name/__hdb_hash/1.hdb;
#    ln -sf /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb ./last_name/Medina/1.hdb
#fi



#[ -f last_name/__hdb_hash/1.hdb ] &&
#    echo "file found"
#    printf "Medina" > last_name/__hdb_hash/1.hdb
#    mv -v -f -t /home/kyle/hdb/schema/dev/person/last_name/Medina `find /home/kyle/hdb/schema/dev/person/last_name -lname /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb -not -path */Medina/*` ||
#    echo "file not found"
#    printf "Medina" > last_name/__hdb_hash/1.hdb
#    ln -sf /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb ./last_name/Medina/1.hdb

#printf "Tyrone" > first_name/__hdb_hash/1.hdb

#ln -sf /home/kyle/hdb/schema/dev/person/first_name/__hdb_hash/1.hdb ./first_name/Sally/1.hdb

#printf "Medina" > last_name/__hdb_hash/1.hdb
#ln -sf /home/kyle/hdb/schema/dev/person/last_name/__hdb_hash/1.hdb ./last_name/Medina/1.hdb

#Jazzamatazz



#mv -v -f -t /home/kyle/hdb/schema/dev/person/first_name/Tyrone `find /home/kyle/hdb/schema/dev/person/first_name -lname /home/kyle/hdb/schema/dev/person/first_name/__hdb_hash/1.hdb -not -path */Tyrone/*`


#find /home/kyle/hdb/schema/dev/person/first_name -not -path /home/kyle/hdb/schema/dev/person/first_name/__hdb_hash -name "{1,2,3}.hdb"