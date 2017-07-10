'use strict';
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
            winston.error(err);
        });
        this.on('end', () => {
            winston.info('fin');
        });
    }

    _read() {
        this.push(this.data);
        this.push(null);
    }
}

module.exports = ReadableStream;