const pjson = require('../package.json');

module.exports = {
   version: version
}

function version(){
    console.log(`HarperDB Version ${pjson.version}`);
    return pjson.version;
}