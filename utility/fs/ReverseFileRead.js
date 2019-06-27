const fs = require('fs-extra');

class ReverseFileRead{
    constructor(file_path, delimiter, read_byte_size){
        this.file_path = file_path;
        this.delimiter = delimiter;
        this.read_byte_size = read_byte_size;
        this.fd = 0;
        this.file_size = 0;
        this.file_bytes_remaining = 0;

        this.data_part = '';
    }

    async run(){
        try {
            this.fd = await fs.open(this.file_path, 'r');
            let stat = await fs.stat(this.file_path);
            this.file_size = this.file_bytes_remaining = stat.size;
            let iteration = 0;
            let resume = true;

            do {
                let read_results = await this.readFile(++iteration);

                if(read_results === undefined){
                    break;
                }
                this.file_bytes_remaining -= read_results.bytesRead;

                let data_array = this.bufferToArray(read_results.buffer);
                resume = this.evaluateData(data_array);

                if([true, false].indexOf(resume) < 0){
                    resume = false;
                }
            }while(resume);
        }catch(e){
            console.error(e);
        } finally {
            if(this.fd) {
                await fs.close(this.fd);
            }
        }
    }

    async readFile(iteration){
        if(this.file_bytes_remaining <=0 ){
            return;
        }

        let start_read_position = this.file_size - (this.read_byte_size * iteration);

        let buffer_size = this.read_byte_size > this.file_bytes_remaining ? this.file_bytes_remaining : this.read_byte_size;
        let buffer = new Buffer.alloc(buffer_size);

        return await fs.read(this.fd, buffer, 0, buffer_size, start_read_position);
    }

    bufferToArray(buffer){
        let data_string = buffer.toString() + this.data_part;

        let data_array = data_string.split(this.delimiter);
        //we remove the first row since we don't know if it is a complete row
        if(this.file_bytes_remaining > 0) {
            this.data_part = data_array.shift();
        }

        return data_array;
    }

    evaluateData(data){
        return true;
    }
}

module.exports = ReverseFileRead;