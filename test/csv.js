const csv_load = require('../data_layer/csvBulkLoad'),
    fs = require('fs');

/*fs.readFile('./data/shelter.csv', (err, data)=>{
   if(err){
       console.error(err);
       return;
   }

    let csv_object = {
      schema:'dev',
        table:'shelter',
        data:data.toString()
    };

   csv_load.csvDataLoad(csv_object, (err, data)=>{
       if(err){
           console.error(err);
           return;
       }

       console.log(data);
   });
});*/
let csv_object = {
    schema:'dev',
    table:'breed',
    file_path:'/home/kyle/WebstormProjects/harperdb/test/data/breeds.csv'
};
csv_load.csvFileLoad(csv_object, (err, data)=>{
    if(err){
        console.error(err);
        return;
    }

    console.log(data);
});

