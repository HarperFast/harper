const logger = require('../../utility/logging/harper_logger');
const Writable = require('stream').Writable;

class WritableStream extends Writable {
    constructor(options) {
        // Calls the stream.Writable() constructor
        super(options);
        this.data = '';

        this.on('error', (err) => {
            logger.error(err);
        });

    }

    _write(chunk, encoding, callback) {
        logger.info('chunk ' + chunk.length);
        this.data += chunk.toString();
        callback();
    }
}

module.exports = WritableStream;