const pjson = require('../package.json');
const search = require('../data_layer/search');
module.exports = {
   version,
    printVersion
};

function version(){
    return pjson.version;
}

function printVersion() {
    console.log(`HarperDB Version ${pjson.version}`);
}
