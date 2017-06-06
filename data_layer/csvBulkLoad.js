const csv=require('csvtojson'),
    insert = require('./insert'),
    _ = require('lodash'),
    request=require('request')
    record_batch_size = 1000,
    async = require('async'),
    csv_converter = csv({flatKeys:true,workerNum:4,ignoreEmpty:true});

module.exports = {
    csvDataLoad: csvDataLoad,
    csvURLLoad: csvURLLoad,
    csvFileLoad: csvFileLoad
};

function csvDataLoad(csv_object, callback){
    csv_records = [];

    csv_converter
        .fromString(csv_object.data)
        .on('json',(jsonObj, rowIndex)=>{
            jsonObj.id = parseInt(rowIndex) +1;
            csv_records.push(jsonObj);
        })
        .on('done',(error)=>{
            bulkLoad(csv_records, csv_object.schema, csv_object.table, (err, data)=>{
                if(err){
                    callback(err);
                    return;
                }

                callback(null, `successfully loaded ${csv_records.length} records`);
            });
        });
}

function csvURLLoad(csv_object, callback){
    csv_records = [];

    csv_converter
        .fromStream(request.get(csv_object.csv_url))
        .on('json',(jsonObj, rowIndex)=>{
            jsonObj.id = parseInt(rowIndex) +1;
            csv_records.push(jsonObj);
        })
        .on('done',(error)=>{
            bulkLoad(csv_records, csv_object.schema, csv_object.table, (err, data)=>{
                if(err){
                    callback(err);
                    return;
                }

                callback(null, `successfully loaded ${csv_records.length} records`);
            });
        });
}

function csvFileLoad(csv_object, callback){
    csv_records = [];

    csv_converter
        .fromFile(csv_object.file_path)
        .on('json',(jsonObj, rowIndex)=>{
            jsonObj.id = parseInt(rowIndex) +1;
            csv_records.push(jsonObj);
        })
        .on('done',(error)=>{
            bulkLoad(csv_records, csv_object.schema, csv_object.table, (err, data)=>{
                if(err){
                    callback(err);
                    return;
                }

                callback(null, `successfully loaded ${csv_records.length} records`);
            });
        }).on('error',(err)=>{
            callback(err);
        });
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