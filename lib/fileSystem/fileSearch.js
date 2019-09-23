const fs = require('graceful-fs'),
    async = require('async'),
    _ = require('lodash');

const FILE_EXTENSION_LENGTH = 4;
const hdb_terms = require('../../utility/hdbTerms');
const INSERT_ENUM = hdb_terms.INSERT_MODULE_ENUM;

module.exports = {
    findIDsByRegex,
    getFiles,
    findDirectoriesByRegex,
    //searchFileSystem
};

function findIDsByRegex(base_path, folder_regex, blob_search, blob_regex, callback){
    async.waterfall([
        findDirectoriesByRegex.bind(null, base_path, folder_regex),
        //getFiles.bind(null, base_path)
        searchFileSystem.bind(null, base_path, blob_regex, blob_search)
    ], (err, ids)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, ids);
    });
}

function findDirectoriesByRegex(base_path, folder_regex, callback){
    fs.readdir(base_path, (err, all_folders)=> {
        if (err) {
            if(err.code === 'ENOENT'){
                callback(null, [], []);
                return;
            }

            callback(err);
        } else {
            let filtered_folders = all_folders.filter((folder) => {
                return folder_regex.test(folder);
            });

            callback(null, filtered_folders, all_folders);
        }
    });
}

function searchFileSystem(base_path, blob_regex, blob_search, filtered_folders, all_folders, callback){
    const blob_folders = _.filter(all_folders, (folder)=>{
        // return Buffer.byteLength(folder) >= 230;
        return Buffer.byteLength(folder) > INSERT_ENUM.MAX_CHARACTER_SIZE;
    });

    async.parallel({
            standard: getFiles.bind(null, base_path, filtered_folders),
            blob: (caller) => {
                //TODO - can I just use the blob_folders to determine if this is a blob search?
                if (blob_search) {
                    let search_results = [];
                    async.eachLimit(blob_folders, 1000, (folder, call) => {
                        blobSearch(`${base_path}${folder}/blob`, blob_regex, (err, results) => {
                            if (err) {
                                return call(err);
                            }

                            search_results = search_results.concat(results);
                            call();
                        });


                    }, (err) => {
                        if (err) {
                            return caller(err);
                        }

                        caller(null, search_results);
                    });
                } else {
                    caller();
                }
            }
        }, (err, results)=> {
            if(err){
                return callback(err);
            }

            let ids = [];

            if(results.standard && results.standard.length > 0) {
                ids = ids.concat(results.standard);
            }

        if(results.blob && results.blob.length > 0){
            ids = ids.concat(results.blob);
        }

        callback(null, ids);
    });
}

function blobSearch(base_path, regex, callback){
    async.waterfall([
        (caller)=>{
            fs.readdir(base_path, (err, files)=>{
                if(err) {
                    if (err.code === 'ENOENT') {
                        return caller(null, []);
                    }

                    return caller(err);
                }

                caller(null, files);
            });
        },
        (files, caller)=>{
            let matching_files = [];
            async.eachLimit(files, 1000, (file, call)=>{
                fs.readFile(base_path+ '/' +file, (err, file_data)=>{
                    if(err){
                        return call(err);
                    }

                    if(regex.test(file_data.toString())){
                        matching_files.push(file);
                    }

                    call();
                });
            }, (err)=>{
                if(err){
                    return caller(err);
                }

                caller(null, convertFileNamesToId(matching_files));
            });
        }
    ], (err, results)=>{
        if(err){
            return callback(err);
        }

        callback(null, results);
    });
}

function getFiles(base_path, folders, callback){
    //if the search sends us actual hdb files we just need to pass them on.
    if(folders && folders.length > 0 && folders[0].endsWith('.hdb')) {
        callback(null, convertFileNamesToId(folders));
        return;
    }

    let all_files = [];
    async.each(folders, (folder, caller)=>{
        fs.readdir(base_path + folder, (err, files)=>{
            if(err){
                if(err.code === 'ENOENT'){
                    caller();
                    return;
                }

                caller(err);
                return;
            }
            files = _.filter(files, (file)=>{
                return file.endsWith('.hdb');
            });

            all_files = all_files.concat(files);
            caller();
        });
    }, (err)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, convertFileNamesToId(all_files));
    });
}


function convertFileNamesToId(all_files){
    // let match_set = new Set();
    // all_files.forEach(function(match) {
    //     match_set.add(match.replace('.hdb', ''));
    // });
    //
    // return Array.from(match_set);
    return all_files.map(file => {
        return file.slice(0, -FILE_EXTENSION_LENGTH);
    });
}