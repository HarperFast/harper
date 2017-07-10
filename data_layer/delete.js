const validate = require('validate.js'),
    PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`),
    bulk_delete_validator = require('../validation/bulkDeleteValidator'),
    conditional_delete_validator = require('../validation/conditionalDeleteValidator'),
    search = require('./search');
    hdb_properties.append(hdb_properties.get('settings_path')),
    async = require('async'),
    fs = require('graceful-fs'),
    global_schema = require('../utility/globalSchema');

const slash_regex =  /\//g;
const base_path = hdb_properties.get('HDB_ROOT') + "/schema/";


module.exports ={
  delete: deleteRecord,
    conditionalDelete:conditionalDelete
};

function deleteRecord(delete_object, callback){
    try {
        let validation = bulk_delete_validator(delete_object);
        if (validation) {
            callback(validation);
            return;
        }

        let search_obj =
            {
                schema: delete_object.schema,
                table: delete_object.table,
                hash_values: delete_object.hash_values,
                get_attributes: ['*']
            };

        async.waterfall([
            global_schema.getTableSchema.bind(null, delete_object.schema, delete_object.table),
            (table_info, callback) => {
                callback();
            },
            search.searchByHashes.bind(null, search_obj),
            deleteRecords.bind(null, delete_object)
        ], (err, data) => {
            if (err) {
                callback(err);
                return;
            }

            callback(null, 'records successfully deleted');
        });
    } catch(e){
        callback(e);
    }
}

function conditionalDelete(delete_object, callback){
    try {
        let validation = conditional_delete_validator(delete_object);
        if (validation) {
            callback(validation);
            return;
        }

        async.waterfall([
            global_schema.getTableSchema.bind(null, delete_object.schema, delete_object.table),
            (table_info, callback) => {
                callback(null, delete_object.conditions, table_info);
            },
            search.multiConditionSearch,
            (ids, callback) => {
                let delete_wrapper = {
                    schema: delete_object.schema,
                    table: delete_object.table,
                    hash_values: ids
                };

                callback(null, delete_wrapper);
            },
            deleteRecord
        ], (err, data) => {
            if (err) {
                callback(err);
                return;
            }

            callback(null, 'records successfully deleted');
        });
    }catch(e){
        callback(e);
    }
}

function deleteRecords(delete_object, records, callback){
    if(!records || records.length < 1){
        callback("Item not found!");
        return;
    }

    async.eachOf(records,
        (record, x, call)=>{
            let delete_wrapper = delete_object;
            delete_wrapper.hash_value = delete_object.hash_values[x];
            deleteFiles(delete_wrapper, record, (e)=>{
                if(e){
                    call(e);
                    return;
                }

                call();
            });
        }, (error)=>{
            if(error){
                callback(error);
                return;
            }

            callback(null, 'records successfully deleted');
        }
    );
}

function deleteFiles(delete_object, record, callback){
    let paths = [];
    let table_path = `${base_path}${delete_object.schema}/${delete_object.table}`;
    Object.keys(record).forEach((attribute)=>{
        paths.push(`${table_path}/__hdb_hash/${attribute}/${delete_object.hash_value}.hdb`);
        let stripped_value = String(record[attribute]).replace(slash_regex, '');
        paths.push(`${table_path}/${attribute}/${stripped_value}/${delete_object.hash_value}.hdb`);
    });

    async.each(paths,
        (path, caller)=>{
            fs.unlink(path, (err)=>{
                if(err){

                    if(err.code === 'ENOENT'){
                        caller();
                        return;
                    }
                    winston.error(err);
                    caller(err);
                    return;
                }

                caller();
            });
        },
        (err)=>{
            if(err){
                callback(err);
                return;
            }

            callback();
    });
}