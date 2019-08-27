"use strict";

let fsr = require('file-stream-rotator');
const log = require('../logging/harper_logger');

/**
 *
 */
class RotatingFileWriteStream{
    constructor(options){
        this.stream = fsr.getStream(options);

        this.stream.on('error', this.errorHandler);
        this.stream.on('rotate', this.rotateHandler);
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

    /**
     *
     * @param old_filename
     * @param new_filename
     */
    rotateHandler(old_filename, new_filename){
        log.trace('rotating:', old_filename, new_filename);
    }
}

module.exports = RotatingFileWriteStream;