const Writable = require('stream').Writable;

class WritableStream extends Writable {
    constructor(options) {
        // Calls the stream.Writable() constructor
        super(options);
        this.data = '';

        this.on('error', (err) => {
            winston.error(err);
        });

    }

    _write(chunk, encoding, callback) {
        winston.info('chunk ' + chunk.length);
        this.data += chunk.toString();
        callback();
    }
}

module.exports = WritableStream;