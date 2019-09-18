"use strict";

const env = require('../../../../utility/environment/environmentManager');
const terms = require('../../../../utility/hdbTerms');

function getBasePath() {
    return `${env.getHdbBasePath()}/${terms.SCHEMA_DIR_NAME}/`;
}

module.exports = getBasePath;