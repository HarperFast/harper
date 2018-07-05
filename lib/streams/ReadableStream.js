'use strict';
const logger = require('../../utility/logging/harper_logger');
const Readable = require('stream').Readable;

class ReadableStream extends Readable {
    constructor(options, data) {
        // Calls the stream.Writable() constructor
        super(options);
        if(Object.prototype.toString.call(data) === '[object Object]'){
            this.data = JSON.stringify(data);
        } else {
            this.data = data;
        }

        this.on('error', (err) => {
            logger.error(err);
        });
        this.on('end', () => {
            logger.info('fin');
        });
    }

    _read() {
        this.push(this.data);
        this.push(null);
    }
}

module.exports = ReadableStream;