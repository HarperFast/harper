'use strict';

const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');

const heliumUtils = require('../../../../utility/helium/heliumUtils');
let hdb_helium = heliumUtils.initializeHelium();

module.exports = createRecords;

function createRecords(insert_obj) {
    let {schema_table, attributes} = insertUpdateValidate(insert_obj);


    return hdb_helium.createDataStores(['dev/person/id', 'dev/person/name']);
}

