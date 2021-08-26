"use strict";

let fs = require('fs-extra');
const logger = require('../utility/logging/harper_logger');

module.exports = {
    version,
    printVersion,
    nodeVersion
};

let jsonData = undefined;

try {
    jsonData = JSON.parse(fs.readFileSync(`${__dirname}/../package.json`, 'utf-8'));
} catch(err) {
    logger.error(`There was a problem loading the package.json file.`);
    logger.error(err);
}

function version() {
    if (jsonData) {
        return jsonData.version;
    }
}

function nodeVersion() {
    if (jsonData && jsonData.engines && jsonData.engines.node) {
        return jsonData.engines.node;
    }

    return undefined;
}

function printVersion() {
    if(jsonData) {
        console.log(`HarperDB Version ${jsonData.version}`);
    }
}
