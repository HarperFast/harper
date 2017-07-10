const schema = require('../data_layer/schema');


var describe_table_object = {"table":"hdb_table","schema":"system"}
console.time('describe table test');

/**
schema.describeAll(function(err, desc){
   winston.info(JSON.stringify(desc));
   if(err)
      winston.error(err);
});
**/
var schemaDescribe = require('../data_layer/schemaDescribe');
    schemaDescribe.describeTable(describe_table_object,function (err, data) {
        winston.info(err);
        winston.info(data);
});




/**
schema.describeTable(describe_table_object, function(err, data){
   winston.info(data);
   winston.error(err);
   console.timeEnd('describe table test');

});

/**
schema.describeSchema({"schema": "dev"}, function(err, data){
   winston.info(err);
   winston.info(data);
}); **/