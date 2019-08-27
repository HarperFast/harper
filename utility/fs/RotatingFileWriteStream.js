"use strict";

const fs = require('fs-extra');
const log = require('../logging/harper_logger');

/**
 *
 */
class FileWriteStream{
    constructor(path, options){
        this.stream = fs.createWriteStream(path, options);

        this.stream.on('error', this.errorHandler);
    }

    /**
     *
     * @param {string} data - data to write to the stream
     * @param {string} encoding - default is set to utf-8
     */
    write(data, encoding = 'utf-8'){
        //write returns a boolean, if it returns false we call the drain event and retry the write
        let ok = this.stream.write(data, encoding);

        if(ok === false){
            this.stream.once('drain', this.write.bind(this, data, encoding));
        }
    }

    /**
     *
     * @param error
     */
    errorHandler(error){
        log.error(error);
    }
}

module.exports = FileWriteStream;