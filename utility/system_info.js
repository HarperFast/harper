const pjson = require(`${__dirname}/../package.json`);

module.exports = {
    systemInfo:systemInfo
};

function systemInfo(){
    let system_info_results = {};
    getVersion(function(version){
       system_info_results.version = version;
       console.log(system_info_results);
    });
}

function getVersion(callback){
   return callback(pjson.version);
}

systemInfo();