const ls = require('node-ls'),
async = require('async'),
fs = require('fs');

let base_path = '/home/kyle/ssd/hdb/schema/iot_data/message/';
let attributes = [
    base_path +'timetoken',
    base_path + 'ambient_temperature',
    base_path + 'humidity',
    base_path + 'radiation_level',
    base_path + 'photosensor',
    base_path + 'sensor_uuid',
    base_path + 'timestamp'
];


/*getValues(base_path, attributes, (err, data)=>{
    console.timeEnd('ls');
    /!*async.each(Object.keys(data), (path, callback)=>{
        console.time('ls ' + path);
        getValues(path, data[path], (error, results)=>{
            console.timeEnd('ls ' + path);
            if(error){
                console.error(error);
            }
            callback();
        });
    }, (err)=>{
        console.timeEnd('ls');
    });*!/
});*/
console.time('ls');
let final = [];
    ls(attributes, 'a', (err, values)=>{
        console.timeEnd('ls');
        Object.keys(values).forEach((key)=>{
            let key_split = key.split('/');
            let attr = key_split[key_split.length - 1];
            async.each(values,(value, (err, data)=>{}))
            values[key].forEach((value)=>{
                final.push({
                    attribute: attr,
                    value: value
                });
            });
        });

        console.log(final.length);

        fs.writeFileSync('/home/kyle/ssd/data.json', JSON.stringify(final));

    });




function getValues(path, attributes, callback){
    let all_values = {};
    async.each(attributes, (attribute, caller)=>{
        let attribute_path = path+attribute+'/';
        console.time('ls' + attribute);
        ls(attribute_path, '-a', (err, values)=>{
           // console.timeEnd('ls' + attribute);
            if(err){
                return caller(err);
            }


        });
    }, (err)=>{
        if(err){
            console.error(err);
        }

        callback(null, all_values);
    });
}