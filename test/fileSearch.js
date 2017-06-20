const file_search = require('../lib/fileSystem/fileSearch'),
    path = require('path'),
    PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`),
patterns = require('../sqlTranslator/conditionPatterns'),
async=require('async'),
_ = require('lodash'),
fs = require('fs');
hdb_properties.append(hdb_properties.get('settings_path'));

const hdb_path = path.join(hdb_properties.get('HDB_ROOT'), '/schema/');
/*

let conditions = [
    {"=":
        ["breed_id","257"]
    },
    {
        "and":{
            "=":
                ["color", "Sable"]
        }
    }
];
let all_ids = [];
async.forEachOf(conditions, (condition, key, callback) =>{
    all_ids[key] = {};
    let condition_key = Object.keys(condition)[0];
    if(condition_key  === 'and' || condition_key === 'or'){
        all_ids[key].operation = condition_key;
        condition = condition[condition_key];
    }

    let pattern = patterns.createPatterns(condition, {name:'shelter', schema:'dev', hash_attribute:'id'}, hdb_path);

    file_search.findIDsByRegex(pattern.folder_search_path, pattern.folder_search, (err, results)=>{
        if(err) {
            console.error(err);
        } else {
            all_ids[key].ids = results;
        }
        callback();
    });
}, (err)=>{
    console.log(all_ids);

    let matched_ids = [];

    all_ids.forEach((ids)=>{
        if(!ids.operation || ids.operation === 'or'){
            matched_ids = matched_ids.concat(ids.ids);
        } else {
            matched_ids = _.intersection(matched_ids, ids.ids);
        }
    });

    console.log(matched_ids);
});*/

/*let pattern = patterns.createPatterns({'=':['id', '257']}, {name:'breed', schema:'dev', hash_attribute:'id'}, hdb_path);

file_search.findDirectoriesByRegex(pattern.folder_search_path, pattern.folder_search, (err, results)=>{
    if(err) {
        console.error(err);
    } else {
        console.log(results);
    }
});*/


fs.readdir(hdb_path + 'dev/breed/__hdb_hash/id', (err, folders)=> {
    if (err) {
        if(err.code === 'ENOENT'){
            //callback(null, []);
            return;
        }

        //callback(err);
    } else {
        let regex = /^257\.hdb$/;
        let filtered_folders = folders.filter((folder) => {
            return regex.test(folder);
        });
        console.log(filtered_folders);
        //callback(null, filtered_folders);
    }
});