'use strict';

module.exports = createRecords;

function createRecords() {
    return global.hdb_helium.createDataStores(['dev/person/id', 'dev/person/name']);
}

