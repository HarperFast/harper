const fs = require('fs'),
    async = require('async');

module.exports = {
    findIDsByRegex: findIDsByRegex,
    getFiles: getFiles,
    findDirectoriesByRegex: findDirectoriesByRegex
};

function findIDsByRegex(base_path, regex, callback){
    async.waterfall([
        findDirectoriesByRegex.bind(null, base_path, regex),
        getFiles.bind(null, base_path)
    ], (err, ids)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, ids);
    });
}

function findDirectoriesByRegex(base_path, regex, callback){
    fs.readdir(base_path, (err, folders)=> {
        if (err) {
            if(err.code === 'ENOENT'){
                callback(null, []);
                return;
            }

            callback(err);
        } else {
            let filtered_folders = folders.filter((folder) => {
                return regex.test(folder);
            });

            callback(null, filtered_folders);
        }
    });
}

function getFiles(base_path, folders, callback){
    //if the search sends us actual hdb files we just need to pass them on.
    if(folders && folders.length > 0 && folders[0].endsWith('.hdb')) {
        callback(null, convertFileNamestoId(folders));
        return;
    }

    let all_files = [];
    async.each(folders, (folder, caller)=>{
        fs.readdir(base_path + folder, (err, files)=>{
            if(err){
                if(err.code === 'ENOENT'){
                    callback();
                    return;
                }

                caller(err);
                return;
            }

            all_files = all_files.concat(files);
            caller();
        });
    }, (err)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, convertFileNamestoId(all_files));
    });
}


function convertFileNamestoId(all_files){
    let match_set = new Set();
    all_files.forEach(function(match) {
        match_set.add(match.replace('.hdb', ''));
    });

    return Array.from(match_set);
}