const csvFilePath='./data/fci-breeds.csv',
    csv=require('csvtojson'),
    insert = require('../data_layer/insert');

var insert_object = {
    operation:'insert',
    schema :  'dev',
    table:'breed',
    hash_attribute: 'id',
    records: []
};

csv()
    .fromFile(csvFilePath)
    .on('json',(jsonObj)=>{
        insert_object.records.push(jsonObj);
    })
    .on('done',(error)=>{
        insert.insert(insert_object, (err, data)=>{
            if(err){
                console.error(err);
            }

            console.log(data);
        });
    });


