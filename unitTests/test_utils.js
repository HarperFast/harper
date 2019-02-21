"use strict"
const path = require('path');
const sinon = require('sinon');
const fs = require('fs');
const env = require('../utility/environment/environmentManager');

/**
 * This needs to be called near the top of our unit tests.  Most will fail when loading harper modules due to the
 * properties reader trying to look in bin.  We can iterate on this to make it smarter if needed, for now this works.
 */
function changeProcessToBinDir() {
    try {
        process.chdir(path.join(process.cwd(), 'bin'));
        console.log(`Current directory ${process.cwd()}`);
    } catch (e) {
        // no-op, we are probably already in bin
    }
}

/**
 This is a simple, naive clone implementation.  It should never, ever! be used in prod.
 */
function deepClone(a) {
    return JSON.parse(JSON.stringify(a));
}

/**
 * Wrap an async function with a try/catch to reduce the amount of test code.  This is OK for unit tests, but prod code should be explicitly wrapped.
 * @param fn
 * @returns {function(*=)}
 */
let mochaAsyncWrapper = (fn) => {
    return (done) => {
        fn.call().then(done, (err)=>{done(err)});
    };
};

/**
 * Call this function near the top of any unit test to assign the unhandledReject event handler (this is due to a bug in Node).
 * This will prevent tests bombing with an unhandled promise rejection in some cases.
 */
function preTestPrep() {
    let unhandledRejectionExitCode = 0;

    process.on("unhandledRejection", (reason) => {
        console.log("unhandled rejection:", reason);
        unhandledRejectionExitCode = 1;
        throw reason;
    });

    process.prependListener("exit", (code) => {
        if (code === 0) {
            process.exit(unhandledRejectionExitCode);
        }
    });
    // Try to change to bin
    changeProcessToBinDir();
    env.initSync();
}

/**
 * Call this function to delete all directories under the specified path.  This is a synchronous function.
 * @param target_path
 */
function cleanUpDirectories(target_path) {
    if(!target_path) return;
    //Just in case
    if(target_path === '/') return;
    let files = [];
    if( fs.existsSync(target_path) ) {
        try {
            files = fs.readdirSync(target_path);
            for(let i = 0; i<files.length; i++) {
                let file = files[i];
                let curPath = path.join(target_path, file);
                if (fs.lstatSync(curPath).isDirectory()) { // recurse
                    cleanUpDirectories(curPath);
                } else {
                    fs.unlinkSync(curPath);
                }
            }
            fs.rmdirSync(target_path);
        } catch (e) {
            console.error(e);
        }
    }
};

module.exports = {
    changeProcessToBinDir:changeProcessToBinDir,
    deepClone:deepClone,
    mochaAsyncWrapper:mochaAsyncWrapper,
    preTestPrep:preTestPrep,
    cleanUpDirectories: cleanUpDirectories
}