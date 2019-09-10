const child_process = require('child_process');
const fs = require('fs');

const VOLUME_LOCATION = __dirname + '/volume/hdb';
const HELIUM_URL_PREFIX = 'he://localhost/';
const DEBUG = false;
const MODE = "Release";


function createVolume(volume_path){
    child_process.execSync(`dd if=/dev/zero of=${volume_path} bs=1k count=$((2 * 1024 * 1024))`);
}

function removeVolume(volume_path){
    fs.unlinkSync(volume_path);
}

module.exports = {
    HELIUM_URL_PREFIX,
    DEBUG,
    MODE,
    createVolume,
    removeVolume
};
