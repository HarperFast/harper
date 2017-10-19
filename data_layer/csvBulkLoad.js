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

                bulkLoad(csv_records, csv_object.schema, csv_object.table, csv_object.action, (err, data) => {
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

        createReadStream(csv_object.csv_url, (err, response)=>{
            if(err){
                return callback(err);
            }

            csv_records = [];

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

                bulkLoad(csv_records, csv_object.schema, csv_object.table, csv_object.action, (err, data) => {
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

function bulkLoad(records, schema, table, action, callback){
    let chunks = _.chunk(records, record_batch_size);

    //TODO: Noone remember why we have this here.  We should refactor this when
    // we have more benchmarks for comparison.  Might be able to leverage cores once
    // the process pool is ready.
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
                    caller(null, data);
                });
                break;
        }

    }, (err)=>{
        if(err){
            callback(err);
            return;
        }
        callback();
    });
}