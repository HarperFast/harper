const fs = require('fs-extra');
const EventEmitter = require('events').EventEmitter;

/**
 * Utility class to implement a file read stream, break each chunk of data apart by line and execute a function against the array of rows.
 * each returned result then gets emitted back.
 */
class FSReadStream extends EventEmitter{
    /**
     *
     * @param file_path - path to file to read
     * @param options - this is the options object passed to an fs read stream: https://nodejs.org/dist/latest-v10.x/docs/api/fs.html#fs_fs_createreadstream_path_options
     * @param line_delimiter - the delimiter used to define a new line.   typically \r\n
     * @param data_function - function to execute on each array chunk of data
     */
    constructor(file_path, options, line_delimiter, data_function){
        super();
        this.file_path = file_path;
        this.fs_read_stream = fs.createReadStream(file_path, options);
        this.fs_read_stream.on('data', this.onData.bind(this));
        this.fs_read_stream.on('end', this.onEnd.bind(this));
        this.fs_read_stream.on('error', this.onError.bind(this));
        this.line_delimiter = line_delimiter;
        this.data_function = data_function;
        this.data_part = '';
        this.has_end_break = true;
    }

    /**
     * the on data event for the fs_read_stream. takes the buffer, converts to string and splits based on the line_delimiter
     * since we are getting chunks of data the last line could possibly be truncate so we also check for that. after the parsing we execute the data_function and emit the results.
     * @param data
     */
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

        let results = this.data_function(data);

        this.emit('data', results);
    }

    onEnd(){
        this.emit('end');
    }

    onError(error){
        this.emit('error', error);
    }

}

module .exports = FSReadStream;