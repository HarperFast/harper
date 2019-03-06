const winston = require('./winston_logger.js'),
    basic_winston = require('winston'),
    moment = require('moment'),
    validator = require('../../validation/readLogValidator');

module.exports = {
    read_log:read_log

}


function read_log(read_log_object, callback){
    let validation = validator(read_log_object);
    if(validation){
        return callback(validation);

    }




    var options = {
        fields: ['level','message','timestamp'],
        limit: 100

    };



    var bones = null;
    switch(read_log_object.log){
        case 'install_log':
            bones = basic_winston;
            basic_winston.configure({
                transports: [

                    new (basic_winston.transports.File)({ filename: `${__dirname}/../../install_log.log`,  level: 'verbose', handleExceptions: true,
                        prettyPrint:true })
                ],exitOnError:false
            });
            break;
        case 'run_log':
            bones = basic_winston;
            basic_winston.configure({
                transports: [

                    new (basic_winston.transports.File)({ filename: `${__dirname}/../../run_log.log`,  level: 'verbose', handleExceptions: true,
                        prettyPrint:true })
                ],exitOnError:false
            });
        default:
            bones = winston;
            break;
    }


    if(read_log_object.from){
        options.from = moment(read_log_object.from);
    }


    if(read_log_object.until && moment(read_log_object.until).isValid()){
        options.until = moment(read_log_object.until);
    }

    if(read_log_object.level){
        options.level = read_log_object.level;
    }

    if(read_log_object.limit){
        options.limit = read_log_object.limit;
    }

    if(read_log_object.order){
        options.order = read_log_object.order;
    }

    if(read_log_object.start){
        options.start = read_log_object.level;
    }



    //
    // Find items logged between today and yesterday.
    //
    bones.query(options, function (err, results) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, results);
        return;
    });


}
