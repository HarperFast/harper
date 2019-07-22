"use strict";

const fs = require('fs-extra');
const promisify = require('util').promisify;
const finished = require('stream').finished;
const p_finished = promisify(finished);
const log = require('../../utility/logging/harper_logger');

/**
 * Utility class to implement a file read stream, break each chunk of data apart by line and execute a function angainst the array of rows.
 * each returned result then gets emitted back.
 */
class FSReadStream {
    /**
     *
     * @param file_path - path to file to read
     * @param options - this is the options object passed to an fs read stream: https://nodejs.org/dist/latest-v10.x/docs/api/fs.html#fs_fs_createreadstream_path_options
     * @param line_delimiter - the delimiter used to define a new line.   typically \r\n
     */
    constructor(file_path, options, line_delimiter){
        this.file_path = file_path;
        this.fs_read_stream = fs.createReadStream(file_path, options);

        this.line_delimiter = line_delimiter;
        this.data_part = '';
        this.has_end_break = true;
    }

    async run(){
        this.fs_read_stream.on('data', this.onData.bind(this));
        this.fs_read_stream.on('error', this.onError.bind(this));
        await p_finished(this.fs_read_stream);
    }

    onError(error){
        log.error(error);
    }

    onData(data){
        let data_string = this.data_part += data.toString();
        this.has_end_break = true;
        if(!data_string.endsWith(this.line_delimiter)){
            this.has_end_break = false;
        }

        let data_array = data_string.split(this.line_delimiter);

        if(!this.has_end_break) {
            this.data_part = data_array.pop();
        } else{
            this.data_part = '';
        }

        return data_array;
    }

}

module .exports = FSReadStream;