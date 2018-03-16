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
    conditionalDelete:conditionalDelete,
    deleteRecords: deleteRecords
};

/**
 * Delete a record and unlink all attributes associated with that record.
 * @param delete_object
 * @param callback
 */
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
            search.searchByHash.bind(null, search_obj),
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
    } catch(e) {
        callback(e);
    }
}

function deleteRecords(delete_object, records, callback){
    if(!records || records.length < 1){
        callback("Item not found!");
        return;
    }
    let hash_attribute = global.hdb_schema[delete_object.schema][delete_object.table].hash_attribute;
    let paths = [];
    let table_path = `${base_path}${delete_object.schema}/${delete_object.table}`;

    records.forEach((record)=>{
        Object.keys(record).forEach((attribute)=>{
            let hash_value = record[hash_attribute];
            paths.push(`${table_path}/__hdb_hash/${attribute}/${hash_value}.hdb`);
            let stripped_value = String(record[attribute]).replace(slash_regex, '');
            stripped_value = stripped_value.length > 255 ? stripped_value.substring(0, 255) + '/blob' : stripped_value;
            paths.push(`${table_path}/${attribute}/${stripped_value}/${hash_value}.hdb`);
        });
    });

    async.each(paths, (path, caller)=>{
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
    }, (err)=>{
        if(err){
            callback(err);
            return;
        }

        callback();
    });
}

/**
 * Removes the sym link for each attribute.  Important to note that this function
 * @param delete_object - The descriptor for the object to be deleted.
 * @param record - The records found that may be deleted
 * @param callback
 */
function deleteFiles(delete_object, record, callback){
    let paths = [];
    let table_path = `${base_path}${delete_object.schema}/${delete_object.table}`;
    Object.keys(record).forEach((attribute)=>{
        paths.push(`${table_path}/__hdb_hash/${attribute}/${delete_object.hash_value}.hdb`);
        let stripped_value = String(record[attribute]).replace(slash_regex, '');
        stripped_value = stripped_value.length > 255 ? stripped_value.substring(0, 255) + '/blob' : stripped_value;
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