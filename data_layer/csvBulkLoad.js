const csv=require('csvtojson'),
    insert = require('./insert'),
    _ = require('lodash'),
    request=require('request'),
    record_batch_size = 1000,
    async = require('async'),
    validator = require('../validation/csvLoadValidator');

module.exports = {
    csvDataLoad: csvDataLoad,
    csvURLLoad: csvURLLoad,
    csvFileLoad: csvFileLoad
};

function csvDataLoad(csv_object, callback){
    try {
        let validation_msg = validator.dataObject(csv_object);
        if (validation_msg) {
            return callback(validation_msg);
        }

        csv_records = [];

        csv()
            .fromString(csv_object.data)
            .on('json', (jsonObj, rowIndex) => {
                csv_records.push(jsonObj);
            })
            .on('done', (error) => {
                if (error) {
                    callback(error);
                    return;
                }

                bulkLoad(csv_records, csv_object.schema, csv_object.table, (err, data) => {
                    if (err) {
                        callback(err);
                        return;
                    }

                    callback(null, `successfully loaded ${csv_records.length} records`);
                });
            });
    } catch(e){
        callback(e);
    }
}

function csvURLLoad(csv_object, callback){
    try {
        let validation_msg = validator.urlObject(csv_object);
        if (validation_msg) {
            return callback(validation_msg);
        }

        csv_records = [];

        csv()
            .fromStream(request.get(csv_object.csv_url))
            .on('json', (jsonObj, rowIndex) => {
                csv_records.push(jsonObj);
            })
            .on('done', (error) => {
                if (error) {
                    callback(error);
                    return;
                }

                bulkLoad(csv_records, csv_object.schema, csv_object.table, (err, data) => {
                    if (err) {
                        callback(err);
                        return;
                    }

                    callback(null, `successfully loaded ${csv_records.length} records`);
                });
            });
    } catch(e){
        callback(e);
    }
}

function csvFileLoad(csv_object, callback){
    try {
        let validation_msg = validator.fileObject(csv_object);
        if (validation_msg) {
            return callback(validation_msg);
        }
        csv_records = [];

        csv()
            .fromFile(csv_object.file_path)
            .on('json', (jsonObj, rowIndex) => {
                csv_records.push(jsonObj);
            })
            .on('done', (error) => {
                if (error) {
                    return callback(error);
                }

                bulkLoad(csv_records, csv_object.schema, csv_object.table, (err, data) => {
                    if (err) {
                        return callback(err);
                    }

                    return callback(null, `successfully loaded ${csv_records.length} records`);
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

function bulkLoad(records, schema, table, callback){
    let chunks = _.chunk(records, record_batch_size);

    async.eachLimit(chunks, 4, (record_chunk, caller)=>{
        let insert_object = {
            operation: 'insert',
            schema: schema,
            table: table,
            records: record_chunk
        };

        insert.insert(insert_object, (err, data)=>{
            if(err){
                caller(err);
                return;
            }

            caller(null, data);
        });

    }, (err)=>{
        if(err){
            callback(err);
            return;
        }

        callback();
    });
}