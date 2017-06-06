



let insert = require('../data_layer/insert');
var insert_object = {"operation":"insert","schema":"system","table":"hdb_license","hash_attribute":"license","records":[{"license_key":"c6a8d0685220d216b8fd77d87cdf3b5bmofi25EiRp03jrl4252120f88a47d0e5382bbf2d783301c"}]};


console.log(JSON.stringify(insert_object));
insert.insert(insert_object, function (err, data) {
    if(err){
        console.error(err);
        return;
    }

    console.log(data);
});
