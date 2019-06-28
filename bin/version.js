let fs = require('fs-extra');

module.exports = {
   version,
    printVersion,
    refresh
};

let jsonData = JSON.parse(fs.readFileSync('../package.json', 'utf-8'));

function version(){
    return jsonData.version;
}

function printVersion() {
    console.log(`HarperDB Version ${jsonData.version}`);
}

function refresh() {
    jsonData = JSON.parse(fs.readFileSync('../package.json', 'utf-8'));
}