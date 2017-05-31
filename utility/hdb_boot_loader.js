const fs = require('fs'),
    isRoot = require('is-root');


    module.exports = {

    insertBootLoader: insertBootLoader,
    getBootLoader: getBootLoader,
    settings:getSettingsFile

}

function insertBootLoader(settings_path, callback){
    if (!isRoot()) {
        callback("Must run as root!");
        return;
    }

    if(!settings_path){
        callback('missing setings');
        return;
    }

    fs.writeFile('/etc/hdb_bootloader.hdb', JSON.stringify({"settings": settings_path}), function(err, data){
        console.log(err);
        if(err){
            callback(err);
            return;
        }

        callback(null, data);
        return;


    });

}


function getSettingsFile(){

   try{
       return JSON.parse(fs.readFileSync('/etc/hdb_bootloader.hdb')).settings;

   }catch(e){
       console.log(e);
       return null;
   }




}


function getBootLoader(callback){
    if (!isRoot()) {
        callback("Must run as root!");
        return;
    }


    try{
        fs.readFile('/etc/hdb_bootloader.hdb', function(err, data){
           if(err){
               callback(err);
               return;

           }


           callback(null, JSON.parse(data));
           return;

        });



    }catch(e){
        callback(e);
        return;
    }

}