'use strict';

const heliumUtils = require('../../../../utility/helium/heliumUtils');
let hdb_helium = heliumUtils.initializeHelium();

module.exports = heCreateAttribute;

function heCreateAttribute(create_attr_obj) {
    let datastore_name = `${create_attr_obj.schema}/${create_attr_obj.table}/${create_attr_obj.attribute}`;
    try {
        hdb_helium.createDataStores([datastore_name]);
    } catch(err) {
        throw err;
    }
}
