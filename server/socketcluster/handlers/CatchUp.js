"use strict";

const FSReadStream = require('../../../utility/fs/FSReadStream');
const log = require('../../../utility/logging/harper_logger');

// eslint-disable-next-line no-magic-numbers
const HIGHWATERMARK = 1024 * 1024 *5;
const READ_STREAM_OPTIONS = {highWaterMark:HIGHWATERMARK};

/**
 * CatchUp class which takes the path to the channel transaction log & returns the records that sit inside the time bounds specified.
 */
class CatchUp extends FSReadStream{
    /**
     * @param {string} file_path
     * @param {number} start_timestamp
     * @param {number} end_timestamp
     */
    constructor(file_path, start_timestamp, end_timestamp){
        super(file_path, READ_STREAM_OPTIONS, '\r\n');
        this.results = [];
        this.start_timestamp = start_timestamp;
        this.end_timestamp = end_timestamp ? end_timestamp : Date.now();
    }

    /**
     *
     * @param {Buffer} data
     */
    onData(data){
        let lines = super.onData(data);

        let resume = this.evaluateData(lines);
        //if we should no longer keep searching we pause and tell the stream to end
        if(resume === false){
            try {
                this.fs_read_stream.pause();
                this.fs_read_stream.emit('end');
            } catch(e){
                console.error(e);
            }
        }
    }

    /**
     * takes the array of comma separated row and parses them into json objects.
     * @param {Array.<string>} data
     * @returns {boolean}
     */
    evaluateData(data){
        let resume = true;
        for(let x = 0; x < data.length; x++){
            let row = data[x];
            if(!row) {
                continue;
            }

            let values = row.split(',');
            let stamp = Number(values[0]);
            let operation = values[1];
            resume = stamp < this.end_timestamp;

            if(this.between(stamp)){
                resume = true;

                let json = this.getJSON(values);

                if(!json) {
                    log.warn('no json');
                    continue;
                }

                let result_object = {
                    timestamp: stamp,
                    operation: operation,
                };

                if (operation === 'insert' || operation === 'update') {
                    result_object.records = json;
                } else if (operation === 'delete') {
                    result_object.hash_values = json;
                }

                this.results.push(result_object);
            }
        }

        return resume;
    }

    /**
     * takes the values array and retrieves the JSON
     * @param {Array.<string>} values
     * @returns {JSON}
     */
    getJSON(values){
        try {
            let json_string = values.slice(2, values.length).join(',');
            return JSON.parse(decodeURIComponent(json_string));
        } catch(e){
            console.error(e);
        }
    }

    /**
     * checks the timestamp is between the start & end timestamps
     * @param {number} value
     * @returns {boolean}
     */
    between(value){
        return value >= this.start_timestamp && value <= this.end_timestamp;
    }
}

module.exports = CatchUp;