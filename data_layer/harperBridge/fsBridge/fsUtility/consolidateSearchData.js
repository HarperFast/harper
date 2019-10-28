"use strict";

module.exports = consolidateSearchData;

function consolidateSearchData(hash_attribute, attributes_data) {
    let results_object = {};
    let data_keys = Object.keys(attributes_data);

    if (!attributes_data || data_keys.length === 0) {
        return results_object;
    }

    let ids;
    if (attributes_data[hash_attribute]) {
        ids = Object.keys(attributes_data[hash_attribute]);
    } else {
        data_keys.forEach(key => {
            let split_key = key.split('.');
            if (split_key.length > 1 && split_key[1] === hash_attribute) {
                ids = Object.keys(attributes_data[key]);
            }
        });
    }

    if (!ids) {
        let id_map = Object.create(null);
        data_keys.forEach(key=>{
            Object.keys(attributes_data[key]).forEach(id=>{
                id_map[id] = null;
            });
        });

        ids = Object.keys(id_map);
    }

    for (let id_key of ids) {
        const row_object = {};
        for (let attribute of data_keys) {
            row_object[attribute] = attributes_data[attribute][id_key];
        }
        results_object[id_key] = row_object;
    }

    return results_object;
}