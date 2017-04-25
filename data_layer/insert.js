'use strict'

const insert_validator = require('../validation/insertValidator.js'),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    settings = require('settings'),
    spawn = require('child_process').spawn,
    child_process = require('child_process'),
    util = require('util'),
    moment = require('moment'),
    mkdirp = require('mkdirp');

const hdb_path = path.join(settings.HDB_ROOT, '/schema');
const regex = /[^0-9a-z]/gi;
const printf_command = 'printf "%s" > %s &';
const mkdir_command = 'mkdir -p %s';
const cd_command = 'cd %s';
const insert_script_command = 'dash %s & nohup dash %s >/dev/null 2>&1 & ';
const delete_command = 'rm -f %s';
const symbolic_link_command = 'ln -sfT %s %s';
const shebang = '#!/usr/bin/env bash';
const touch_date_command = 'touch -m -h -d "%s" %s';

module.exports = {
    insert: function (insert_object, callback) {

        //validate insert_object for required attributes
        var validator = insert_validator(insert_object);
        if (validator) {
            callback(validator);
            return;
        }

        //check if schema / table directories exist
        var table_path = path.join(hdb_path, insert_object.schema, insert_object.table);
        /*if (!checkPathExists(table_path)) {
         callback('Table: ' + insert_object.schema + '.' + insert_object.table + ' does not exist');
         return;
         }*/
        //TODO verify hash_attribute is correct for this table

        //preprocess all record attributes
        async.waterfall([
            checkAttributeSchema.bind(null, insert_object),
            processData
        ], (err) =>{
            if(err){
                callback(err);
                return;
            }

            callback(null, `successfully wrote ${insert_object.records.length} records`);
        });
    }
};

function checkAttributeSchema(insert_object, callerback) {
    //console.time('script_builder')
    var epoch = new Date().valueOf();
    var date = new moment().format(`YYYY-MM-DD HH:mm:ss.${process.hrtime()[1]} ZZ`);

    var insert_objects = [];
    var symbolic_links = [];
    var touch_links = [];

    var folders = {};
    var hash_folders = {};
    var delete_folders = {};
    var base_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table + '/';
    async.each(insert_object.records, function(record, callback){
        var attribute_objects = [];
        var link_objects = [];

        for(var property in record){
            var value_stripped = String(record[property]).replace(regex, '').substring(0, 4000);
            var attribute_file_name = record[insert_object.hash_attribute] + '.hdb';
            var attribute_path =  base_path + property + '/' + value_stripped;

            hash_folders[base_path + property + '/__hdb_hash'] = "";
            attribute_objects.push({file_name:`${base_path + property}/__hdb_hash/${attribute_file_name}`, value:record[property]});
            if(property !== insert_object.hash_attribute && record[property]) {
                folders[attribute_path] = "";

                link_objects.push({link:`../__hdb_hash/${attribute_file_name}`, file_name:`${attribute_path}/${attribute_file_name}`});
            } else if(property === insert_object.hash_attribute){
                hash_folders[attribute_path] = "";
                attribute_objects.push({file_name:`${attribute_path}/${record[insert_object.hash_attribute]}-${epoch}.hdb`, value:JSON.stringify(record)});
            }
        }
        insert_objects = insert_objects.concat(attribute_objects);
        symbolic_links = symbolic_links.concat(link_objects);
        callback();
    }, function(err){
        if(err) {
            callerback(err);
            return;
        }
        var data_wrapper = {
            data_folders:Object.keys(hash_folders),
            data:insert_objects,
            link_folders:Object.keys(folders),
            links:symbolic_links
        };

        return callerback(null, data_wrapper);
    });
}

function processData(data_wrapper, callback){
    async.parallel([
        writeRawData.bind(null, data_wrapper.data_folders, data_wrapper.data),
        writeLinks.bind(null, data_wrapper.link_folders, data_wrapper.links),
    ], (err, results)=>{
        if(err) {
            callback(err);
            return;
        }
        callback();
    });
}

function writeRawData(folders, data, callback) {
    async.waterfall([
        createFolders.bind(null, folders),
        writeRawDataFiles.bind(null, data)
    ], (err, results)=>{
        if(err){
            callback(err);
            return;
        }
        callback();
    });
}

function writeRawDataFiles(data, callback){
    async.each(data, (attribute, caller)=>{
        fs.writeFile(attribute.file_name, attribute.value, (err)=>{
            if(err){
                caller(err);
                return;
            }

            caller();
        });
    }, function(err){
        if(err){
            callback(err);
            return;
        }

        callback();
    });
}

function writeLinks(folders, links, callback){
    async.waterfall([
        createFolders.bind(null, folders),
        writeLinkFiles.bind(null, links)
    ], (err, results)=>{
        if(err){
            callback(err);
            return;
        }
        callback();
    });
}

function writeLinkFiles(links, callback){
    async.each(links, (link, caller)=>{
        fs.symlink(link.link, link.file_name, (err)=>{
            if(err && err.code !== 'EEXIST'){
                caller(err);
                return;
            }

            caller();
        });
    }, function(err){
        if(err){
            callback(err);
            return;
        }

        callback();
    });
}

function createFolders(folders, callback){
    async.each(folders, (folder, caller)=>{
        mkdirp(folder, (err)=>{
            if(err){
                caller(`mkdir on: ${folder} failed ${err}`);
                return;
            }

            caller();
        });
    }, function(err){
        if(err){
            callback(err);
            return;
        }

        callback();
    });
}