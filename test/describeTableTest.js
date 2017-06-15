const schema = require('../data_layer/schema');


var describe_table_object = {"table":"hdb_table","schema":"system"}
console.time('describe table test');

/**
schema.describeAll(function(err, desc){
   console.log(JSON.stringify(desc));
   if(err)
      console.error(err);
});
**/
var schemaDescribe = require('../data_layer/schemaDescribe');
    schemaDescribe.describeTable(describe_table_object,function (err, data) {
        console.log(err);
        console.log(data);
});




/**
schema.describeTable(describe_table_object, function(err, data){
   console.log(data);
   console.error(err);
   console.timeEnd('describe table test');

});

/**
schema.describeSchema({"schema": "dev"}, function(err, data){
   console.log(err);
   console.log(data);
}); **/