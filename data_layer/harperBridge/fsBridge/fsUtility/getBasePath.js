"use strict";

const env = require('../../../../utility/environment/environmentManager');
const terms = require('../../../../utility/hdbTerms');

function getBasePath() {
    return `${env.getHdbBasePath()}/${terms.HDB_SCHEMA_DIR}/`;
}

module.exports = getBasePath;