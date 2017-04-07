const schema = require('../data_layer/schema');

var describe_table_object = {"table":"person", "schema":"dev"}
console.time('describe table test');

schema.describeTable(describe_table_object, function(err, data){
   console.log(data);
   console.error(err);
   console.timeEnd('describe table test');

});

