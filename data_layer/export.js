const search = require('./search'),
      sql = require('../sqlTranslator/index').evaluateSQL,
      AWS = require('aws-sdk');


    module.exports = {
        export_to_s3: export_to_s3
    };

function export_to_s3 (export_object, callback){
    if(!export_object.format ){
        return callback("format missing");
    }

    if(export_object.format != 'json' && export_object.format != 'csv' ){
        return callback("format invalid. must be json or csv.");
    }

    if(!export_object.s3){
        return callback("S3 object missing");
    }

    if(!export_object.s3.aws_access_key_id){
        return callback("S3.aws_access_key_id missing");
    }

    if(!export_object.s3.aws_secret_access_key){
        return callback("S3.aws_secret_access_key missing");
    }

    if(!export_object.s3.bucket){
        return callback("S3.bucket missing");
    }

    if(!export_object.s3.key){
        return callback("S3.key missing");
    }

    if(!export_object.search_operation){
        return callback("search_operation missing");
    }

    if(!export_object.search_operation.operation){
        return callback("search_operation.operation missing");
    }

    let operation;
    switch(export_object.search_operation.operation){
        case 'search_by_value':
            operation = search.searchByValue;
            break;
        case 'search_by_hash':
            operation = search.searchByHash;
            break;
        case 'sql':
            operation = sql;
            break;
    }


    operation(export_object.search_operation, function(err, results){
        if(err){
            return callback(err);
        }
        AWS.config.update({
            accessKeyId: export_object.s3.aws_access_key_id ,
            secretAccessKey:export_object.s3.aws_secret_access_key
        });
        var s3 = new AWS.S3();
        params = {Bucket: export_object.s3.bucket, Key: export_object.s3.key, Body: JSON.stringify(results)};
        s3.putObject(params, function(err, data) {

            if (err) {
               return callback(err);
            }

            return callback(null, data);
        });



    });




}