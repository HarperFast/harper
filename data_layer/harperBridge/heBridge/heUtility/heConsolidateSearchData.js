"use strict";

module.exports = heConsolidateSearchData;

function heConsolidateSearchData(data_stores, attributes_data) {
    console.log('Data: ', data_stores, attributes_data);

    // let results_object = {};
    // let data_keys = Object.keys(attributes_data);
    //
    // if (!attributes_data || data_keys.length === 0) {
    //     return results_object;
    // }
    //
    // let ids;
    // if (attributes_data[hash_attribute]) {
    //     ids = Object.keys(attributes_data[hash_attribute]);
    // } else {
    //     Object.keys(attributes_data).forEach(key => {
    //         let split_key = key.split('.');
    //         if (split_key.length > 1 && split_key[1] === hash_attribute) {
    //             ids = Object.keys(attributes_data[key]);
    //         }
    //     });
    // }
    //
    // if (!ids) {
    //     ids = Object.keys(attributes_data[Object.keys(attributes_data)[0]]);
    // }
    //
    // for (let id_key of ids) {
    //     const row_object = {};
    //     for (let attribute of data_keys) {
    //         row_object[attribute] = attributes_data[attribute][id_key];
    //     }
    //     results_object[id_key] = row_object;
    // }
    //
    // return results_object;
    return {1: {name: "Sam"}};
}