"use strict";

const env = require('../../../utility/environment/environmentManager');

function getBasePath() {
    return `${env.getHdbBasePath()}/schema/`;
}

module.exports = {
    getBasePath
};