const csvFilePath='./data/fci-breeds.csv',
    csv=require('csvtojson'),
    insert = require('../data_layer/insert');

let insert_object = {
    operation:'insert',
    schema :  'dev',
    table:'breed',
    hash_attribute: 'id',
    records: []
};
csv()
    .fromFile(csvFilePath)
    .on('json',(jsonObj, rowIndex)=>{
        jsonObj.id = parseInt(rowIndex) +1;
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

/*csv()
    .fromFile('./data/2017-dog-license.csv')
    .on('json',(jsonObj, rowIndex)=>{
        jsonObj.id = parseInt(rowIndex) + 1;
        jsonObj.breed = Math.floor(Math.random() * (344 - 0)) + 1;
        insert_object.records.push(jsonObj);
    })
    .on('done',(error)=>{
        insert.insert(insert_object, (err, data)=>{
            if(err){
                console.error(err);
            }

            console.log(data);
        });
    });*/


