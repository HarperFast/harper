// logger.js
var winston = require('winston');
PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));


const logger = new (winston.Logger)({
    transports: [
        new(winston.transports.File)({
            level: 'error',
           filename:`${hdb_properties.get('HDB_ROOT')}/log/hdb_log.log`,
            handleExceptions: true,
            prettyPrint:true
        })
        // In case you need more transports uncomment:
        //,
        //new (winston.transports.Console)({
        //    level:'silly',
        //    handleExceptions: true,
        //    prettyPrint:true
        //})
    ],exitOnError:false
});

module.exports=logger;