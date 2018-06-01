const csv=require('csvtojson'),
    insert = require('./insert'),
    _ = require('lodash'),
    request=require('request'),
    record_batch_size = 1000,
    async = require('async'),
    validator = require('../validation/csvLoadValidator');

const hdb_utils = require('../utility/common_utils');
const {promisify} = require('util');

// Promisify bulkLoad to avoid more of a refactor for now.
const p_bulk_load = promisify(bulkLoad);

module.exports = {
    csvDataLoad: csvDataLoad,
    csvURLLoad: csvURLLoad,
    csvFileLoad: csvFileLoad
};
/**
 * Load a csv values specified in the message 'data' field.
 *
 * @param csv_object - An object representing the CSV file.
 * @returns validation_msg - Contains any validation errors found
 * @returns error - any errors found reading the csv file
 * @returns err - any errors found during the bulk load
 *
 */
async function csvDataLoad(csv_object){
    let validation_msg = validator.dataObject(csv_object);
    if (validation_msg) {
        throw new Error(validation_msg);
    }

    let csv_records = [];
    let bulk_load_result = undefined;
    try {
        csv_records = await csv().fromString(csv_object.data);
        bulk_load_result = await p_bulk_load(csv_records, csv_object.schema, csv_object.table, csv_object.action);
    } catch(e) {
        throw new Error(e);
    }

    return `successfully loaded ${bulk_load_result.inserted_hashes.length} records`;
}

/**
 * Load a csv file from a URL.
 *
 * @param csv_object - An object representing the CSV file via URL.
 * @param callback
 * @returns validation_msg - Contains any validation errors found
 * @returns error - any errors found reading the csv file
 * @returns err - any errors found during the bulk load
 *
 */
function csvURLLoad(csv_object, callback){
    try {
        let validation_msg = validator.urlObject(csv_object);
        if (validation_msg) {
            return callback(validation_msg);
        }

        createReadStream(csv_object.csv_url, (err, response)=>{
            if(err){
                return callback(err);
            }

            let csv_records = [];

            csv()
                .fromStream(response)
                .on('json', (jsonObj, rowIndex) => {
                    csv_records.push(jsonObj);
                })
                .on('done', (error) => {
                    if (error) {
                        callback(error);
                        return;
                    }

                    bulkLoad(csv_records, csv_object.schema, csv_object.table, csv_object.action, (err, data) => {
                        if (err) {
                            callback(err);
                            return;
                        }
                        callback(null, `successfully loaded ${csv_records.length} records`);
                    });
                })
                .on('error', (err) => {
                    return callback(err);
                });
        });
    } catch(e){
        callback(e);
    }
}

function createReadStream(url, callback){
    request.get(url)
        .on('response', (response)=>{
            if (response.statusCode !== 200 || response.headers['content-type'].indexOf('text/csv') < 0) {
                let return_object = {
                    message: `CSV Load failed from URL: ${url}`,
                    status_code: response.statusCode,
                    status_message: response.statusMessage,
                    content_type: response.headers['content-type']
                };
                return callback(return_object);
            }

            return callback(null, response);
        });
}

/**
 *
 * @param csv_object - An object representing the CSV file.
 * @param callback
 * @returns validation_msg - Contains any validation errors found
 * @returns error - any errors found reading the csv file
 * @return err - any errors found during the bulk load
 *
 */
function csvFileLoad(csv_object, callback){
    try {
        let validation_msg = validator.fileObject(csv_object);
        if (validation_msg) {
            return callback(validation_msg);
        }
        let csv_records = [];

        csv()
            .fromFile(csv_object.file_path)
            .on('json', (jsonObj, rowIndex) => {
                csv_records.push(jsonObj);
            })
            .on('done', (error) => {
                if (error) {
                    return callback(error);
                }

                bulkLoad(csv_records, csv_object.schema, csv_object.table, csv_object.action, (err, data) => {
                    if (err) {
                        return callback(err);
                    }
                    return callback(null, data);
                });
            }).on('error', (err) => {
                if(err.message && err.message === 'File not exists'){
                    return callback(`file ${csv_object.file_path} not found`);
                }
            return callback(err);
        });
    } catch(e){
        callback(e);
    }
}

/**
 * Performs either a bulk insert or update depending on the action passed to the function.
 * @param records - The records to be inserted/updated
 * @param schema - The schema containing the specified table
 * @param table - The table to perform the insert/update
 * @param action - Specify either insert or update the specified records
 * @param callback - The caller
 */
function bulkLoad(records, schema, table, action, callback){
    let chunks = _.chunk(records, record_batch_size);
    let update_status = '';
    //TODO: Noone remember why we have this here.  We should refactor this when
    // we have more benchmarks for comparison.  Might be able to leverage cores once
    // the process pool is ready.
    if( !action )
        action = 'insert';
    async.eachLimit(chunks, 4, (record_chunk, caller)=>{
        let target_object = {
            schema: schema,
            table: table,
            records: record_chunk
        };

        switch (action) {
            case 'insert':
                target_object.operation = 'insert';
                insert.insert(target_object, (err, data)=>{
                    if(err){
                        caller(err);
                        return;
                    }
                    update_status = data;
                    caller(null, data);
                });
                break;
            case 'update':
                target_object.operation = 'update';
                insert.update(target_object, (err, data)=>{
                    if(err){
                        caller(err);
                        return;
                    }
                    update_status = data;
                    caller(null, data);
                });
                break;
        }

    }, (err)=>{
        if(err){
            callback(err);
            return;
        }
        if( update_status.length === 0) {
            callback('There was a problem with this operation.  Please check the input file.')
        }
        callback(null,update_status);
    });
}