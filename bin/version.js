const pjson = require('../package.json');

module.exports = {
   version: version,
    printVersion, printVersion
}

function version(){
    return pjson.version;
}

function printVersion() {
    console.log(`HarperDB Version ${pjson.version}`);
}