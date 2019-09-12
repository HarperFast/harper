"use strict";

const common_utils = require('../../../../utility/common_utils');

module.exports = heConsolidateSearchData;

function heConsolidateSearchData(attrs_keys, attrs_data) {
    let final_data = {};

    attrs_data.forEach(row => {
        let row_obj = {};
        row[1].forEach((data, i) => {
            row_obj[attrs_keys[i]] = common_utils.autoCast(data.toString());
        });
        final_data[row[0]] = row_obj;
    })

    return final_data;
}