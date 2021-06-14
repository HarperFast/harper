"use strict";

const env = require('../utility/environment/environmentManager');
env.initSync();

const fs = require('fs-extra');
const path = require('path');
const install = require('../utility/install/installer');
const colors = require("colors/safe");
const logger = require('../utility/logging/harper_logger');
const final_logger = logger.finalLogger();
const pjson = require(`${__dirname}/../package.json`);
const terms = require('../utility/hdbTerms');
const install_user_permission = require('../utility/install_user_permission');
const hdb_utils = require('../utility/common_utils');
const { promisify } = require('util');
const stop = require('./stop');
const upgrade = require('./upgrade');
const hdb_license = require('../utility/registration/hdb_license');
const hdbInfoController = require('../data_layer/hdbInfoController');

const SYSTEM_SCHEMA = require('../json/systemSchema.json');
const schema_describe = require('../data_layer/schemaDescribe');
const lmdb_create_txn_environment = require('../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbCreateTransactionsEnvironment');

const CreateTableObject = require('../data_layer/CreateTableObject');

// These may change to match unix return codes (i.e. 0, 1)
const ENOENT_ERR_CODE = -2;

const FOREGROUND_ENV = env.getProperty(terms.HDB_SETTINGS_NAMES.RUN_IN_FOREGROUND);
const RUN_IN_FOREGROUND = FOREGROUND_ENV === 'true' || FOREGROUND_ENV === true || FOREGROUND_ENV === 'TRUE';

const IPC_SERVER_CWD = path.resolve(__dirname, '../server/ipc');

const NO_IPC_PORT_FOUND_ERR = 'Error getting IPC server port from environment variables';
const NO_HDB_PORT_FOUND_ERR = 'Error getting HDB server port from environment variables';
const IPC_FORK_ERR = 'There was an error starting the IPC server, check the log for more details.';
const HDB_SERVER_ERR = 'There was an error starting the HDB server, check the log for more details.';
const CF_SERVER_ERR = 'There was an error starting the Custom Functions server, check the log for more details.';
const FOREGROUND_ERR = 'There was an error foreground handler, check the log for more details.';
const UPGRADE_COMPLETE_MSG = 'Upgrade complete.  Starting HarperDB.';
const UPGRADE_ERR = 'Got an error while trying to upgrade your HarperDB instance.  Exiting HarperDB.';
const ALREADY_RUNNING_ERR = 'HarperDB is already running.';
const HDB_NOT_FOUND_MSG = 'HarperDB not found, starting install process.';
const INSTALL_ERR = 'There was an error during install, check install_log.log for more details.  Exiting.';

// promisified functions
const p_install_install = promisify(install.install);

let fork = require('child_process').fork;
let child = undefined;
let ipc_child = undefined;
let cf_child = undefined;

/***
 * Starts Harper DB.  If Harper is already running, or the port is in use, and error will be thrown and Harper will not
 * start.  If the hdb_boot_props file is not found, it is assumed an install needs to be performed.
 */
async function run() {
    // Check to see if HDB is already running, if it is return/stop run.
    try {
        if(await hdb_utils.isServerRunning(terms.HDB_PROC_NAME)) {
            console.log(ALREADY_RUNNING_ERR);
            final_logger.notify(ALREADY_RUNNING_ERR);
            return;
        }
    } catch(err) {
        console.error(err);
        final_logger.error(err);
        process.exit(1);
    }

    // Check to see if HDB is installed, if it isn't we call install.
    try {
        if (await isHdbInstalled() === false) {
            console.log(HDB_NOT_FOUND_MSG);
            try {
                await p_install_install();
            } catch(err) {
                console.error(INSTALL_ERR);
                final_logger.error(err);
                process.exit(1);
            }
        }

        // Check to see if an upgrade is needed based on existing hdb_info data.  If so, we need to force the user to upgrade
        // before the server can be started.
        let upgrade_vers;
        try {
            const update_obj = await hdbInfoController.getVersionUpdateInfo();
            if (update_obj !== undefined) {
                upgrade_vers = update_obj[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION];
                await upgrade.upgrade(update_obj);
                console.log(UPGRADE_COMPLETE_MSG);
            }
        } catch(err) {
            if (upgrade_vers) {
                console.error(`Got an error while trying to upgrade your HarperDB instance to version ${upgrade_vers}.  Exiting HarperDB.`);
                final_logger.error(err);
            } else {
                console.error(UPGRADE_ERR);
                final_logger.error(err);
            }
            process.exit(1);
        }

        await checkTransactionLogEnvironmentsExist();
        await launchIPCServer();
        await launchCustomFunctionServer();
        await launchHdbServer();
    } catch(err) {
        console.error(err);
        final_logger.error(err);
        process.exit(1);
    }
}

/**
 * iterates the system schema & all other schemas and makes sure there is a transaction environment for the schema.table
 * @returns {Promise<void>}
 */
async function checkTransactionLogEnvironmentsExist(){
    if(env.getHdbBasePath() !== undefined && env.getDataStoreType() === terms.STORAGE_TYPES_ENUM.LMDB){
        final_logger.info('Checking Transaction Environments exist');

        for (const table_name of Object.keys(SYSTEM_SCHEMA)) {
            await openCreateTransactionEnvironment(terms.SYSTEM_SCHEMA_NAME, table_name);
        }

        let describe_results = await schema_describe.describeAll();

        for (const schema_name of Object.keys(describe_results)) {
            for (const table_name of Object.keys(describe_results[schema_name])) {
                await openCreateTransactionEnvironment(schema_name, table_name);
            }
        }

        final_logger.info('Finished checking Transaction Environments exist');
    }
}

/**
 * runs the create environment command for the specified schema.table
 * @param {string} schema
 * @param {string} table_name
 * @returns {Promise<void>}
 */
async function openCreateTransactionEnvironment(schema, table_name){
    try {
        let create_tbl_obj = new CreateTableObject(schema, table_name);
        await lmdb_create_txn_environment(create_tbl_obj);
    } catch(e){
        let error_msg = `Unable to create the transaction environment for ${schema}.${table_name}, due to: ${e.message}`;
        console.error(error_msg);
        final_logger.error(error_msg);
    }
}

async function launchHdbServer() {
    // Get the HDB server port from env vars, if for some reason it's undefined use the default one.
    let hdb_server_port;
    try {
        hdb_server_port = env.get(terms.HDB_SETTINGS_NAMES.SERVER_PORT_KEY);
        hdb_server_port = hdb_utils.isEmpty(hdb_server_port) ? terms.HDB_SETTINGS_DEFAULT_VALUES.SERVER_PORT : hdb_server_port;
    } catch(err) {
        final_logger.error(err);
        console.error(NO_HDB_PORT_FOUND_ERR);
        process.exit(1);
    }

    // Check to see if the HDB port is available.
    try {
        const is_port_taken = await hdb_utils.isPortTaken(hdb_server_port);
        if (is_port_taken === true) {
            final_logger.fatal(`Port: ${hdb_server_port} is being used by another process and cannot be used by the HDB server. Please update the HDB server port in the HDB config/settings.js file.`);
            console.log(`Port: ${hdb_server_port} is being used by another process and cannot be used by the HDB server. Please update the HDB server port in the HDB config/settings.js file.`);
            process.exit(1);
        }
    } catch(err) {
        final_logger.error(err);
        console.error(`Error checking for port ${hdb_server_port}. Check log for more details.`);
        process.exit(1);
    }

    // Check user has required permissions to start HDB.
    try {
        install_user_permission.checkPermission();
    } catch(err) {
        final_logger.error(err);
        console.error(err.message);
        process.exit(1);
    }

    // Launch the HDB server as a child process.
    try {
        const hdb_args = hdb_utils.createForkArgs(path.resolve(__dirname, '../', 'server', terms.HDB_PROC_NAME));
        const license = hdb_license.licenseSearch();
        const mem_value = license.ram_allocation ? terms.MEM_SETTING_KEY + license.ram_allocation
            : terms.MEM_SETTING_KEY + terms.RAM_ALLOCATION_ENUM.DEFAULT;

        let fork_options = {
            detached: true,
            stdio: 'ignore',
            execArgv: [mem_value]
        };

        //because we may need to push logs to std out/err if the process runs in foreground we need to remove the stdio: ignore
        if(RUN_IN_FOREGROUND){
            delete fork_options.stdio;
        }

        child = fork(hdb_args[0], [hdb_args[1]], fork_options);
    } catch(err) {
        console.error(HDB_SERVER_ERR);
        final_logger.error(err);
        process.exit(1);
    }

    console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname,'../utility/install/ascii_logo.txt'))));
    console.log(colors.magenta(`|------------- HarperDB ${pjson.version} successfully started ------------|`));

    try {
        foregroundHandler();
    } catch(err) {
        console.error(FOREGROUND_ERR);
        final_logger.error(err);
        process.exit(1);
    }
}

/**
 * if foreground is passed as an env setting we do not exit the process
 * also if foreground is passed we setup the processExitHandler to call the stop handler which kills the hdb processes
 */
function foregroundHandler() {
    if (!RUN_IN_FOREGROUND) {
        ipc_child.unref();
        child.unref();
        cf_child.unref();

        // Exit run process with success code.
        process.exit(0);
    }

    process.on('exit', processExitHandler);

    //catches ctrl+c event
    process.on('SIGINT', processExitHandler);

    // catches "kill pid"
    process.on('SIGUSR1', processExitHandler);
    process.on('SIGUSR2', processExitHandler);
}

/**
 * If running in foreground and exit event occurs stop is called
 * @returns {Promise<void>}
 */
async function processExitHandler() {
    if (RUN_IN_FOREGROUND) {
        try {
            await stop.stop();
        } catch(err) {
            console.error(err);
        }
    }
}

function createForkArgs(module_path){
    let args = [];
    if(terms.CODE_EXTENSION === terms.COMPILED_EXTENSION){
        args.push(path.resolve(__dirname, '../', 'node_modules', 'bytenode', 'cli.js'));
    }
    args.push(module_path);
    return args;
}


module.exports ={
    run:run
};

/**
 *
 * @returns {Promise<boolean>}
 */
async function isHdbInstalled() {
    try {
        await fs.stat(env.BOOT_PROPS_FILE_PATH);
        await fs.stat(env.get(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
    } catch(err) {
        if(err.errno === ENOENT_ERR_CODE) {
            // boot props not found, hdb not installed
            return false;
        }

        final_logger.error(`Error checking for HDB install - ${err}`);
        throw err;
    }

    return true;
}

/**
 * Validates the the IPC server is not already running and its port is available,
 * then forks a child process which the IPC server will run on.
 * @returns {Promise<void>}
 */
async function launchIPCServer() {
    // If there is already an instance of the HDB IPC server running we kill it.
    if (await hdb_utils.isServerRunning(path.join(IPC_SERVER_CWD, terms.IPC_SERVER_MODULE))) {
        try {
            await hdb_utils.stopProcess(path.join(IPC_SERVER_CWD, terms.IPC_SERVER_MODULE));
        } catch(err) {
            const err_msg = `An existing HDB IPC server process was found to be running and was attempted to be killed but received the following error: ${err}`;
            final_logger.error(err_msg);
            console.error(err_msg);
            process.exit(1);
        }
    }

    // Get the IPC server port from env vars, if for some reason it's undefined use the default one.
    let ipc_server_port;
    try {
        ipc_server_port = env.get(terms.HDB_SETTINGS_NAMES.IPC_SERVER_PORT);
        ipc_server_port = hdb_utils.isEmpty(ipc_server_port) ? terms.HDB_SETTINGS_DEFAULT_VALUES.IPC_SERVER_PORT : ipc_server_port;
    } catch(err) {
        final_logger.error(err);
        console.error(NO_IPC_PORT_FOUND_ERR);
        process.exit(1);
    }

    // Check to see if the IPC port is available.
    try {
        const is_port_taken = await hdb_utils.isPortTaken(ipc_server_port);
        if (is_port_taken === true) {
            console.log(`Port: ${ipc_server_port} is being used by another process and cannot be used by the IPC server. Please update the IPC server port in the HDB config/settings.js file.`);
            process.exit(1);
        }
    } catch(err) {
        final_logger.error(err);
        console.error(`Error checking for port ${ipc_server_port}. Check log for more details.`);
        process.exit(1);
    }

    // Launch IPC server as a child background process.
    try {
        const ipc_fork_args = hdb_utils.createForkArgs(path.resolve(__dirname, '../', 'server/ipc', terms.IPC_SERVER_MODULE));
        let fork_options = {
            detached: true,
            stdio: 'ignore'
        };

        //because we may need to push logs to std out/err if the process runs in foreground we need to remove the stdio: ignore
        if(RUN_IN_FOREGROUND){
            delete fork_options.stdio;
        }
        ipc_child = fork(ipc_fork_args[0], [ipc_fork_args[1]], fork_options);
    } catch(err) {
        console.error(IPC_FORK_ERR);
        final_logger.error(err);
        process.exit(1);
    }
}

/**
 * Validates the the Custom Functions server is not already running and its port is available,
 * then forks a child process which the Custom Functions server will run on.
 * @returns {Promise<void>}
 */
async function launchCustomFunctionServer() {
    if (env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY)) {
        final_logger.info('Running run/launchCustomFunctionServer()');
        const cf_server_port = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY) || terms.HDB_SETTINGS_DEFAULT_VALUES.CUSTOM_FUNCTIONS_PORT_KEY;

        // Check to see if the HDB port is available.
        try {
            const is_port_taken = await hdb_utils.isPortTaken(cf_server_port);
            if (is_port_taken === true) {
                console.log(`Port: ${cf_server_port} is being used by another process and cannot be used by the Custom Functions server. Please update the Custom Functions server port in the HDB config/settings.js file.`);
                process.exit(1);
            }
        } catch(err) {
            final_logger.error(err);
            console.error(`Error checking for port ${cf_server_port}. Check log for more details.`);
            process.exit(1);
        }

        // Launch the Custom Function server as a child background process.
        try {
            const cf_args = hdb_utils.createForkArgs(path.resolve(__dirname, '../', 'server/customFunctions', terms.CUSTOM_FUNCTION_PROC_NAME));
            let fork_options = {
                detached: true,
                stdio: 'ignore'
            };

            //because we may need to push logs to std out/err if the process runs in foreground we need to remove the stdio: ignore
            if(isForegroundProcess()){
                delete fork_options.stdio;
            }

            cf_child = fork(cf_args[0], [cf_args[1]], fork_options);

            final_logger.trace(`custom function for args: ${cf_args[0]}`);
        } catch(err) {
            console.error(CF_SERVER_ERR);
            final_logger.error(err);
            process.exit(1);
        }
    } else {
        final_logger.notify(`Custom Functions server not enabled. To enable the Custom Functions server, set CUSTOM_FUNCTIONS to true the HDB config/settings.js file.`);
    }
}
