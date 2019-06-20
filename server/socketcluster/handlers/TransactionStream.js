const FSReadStream = require('../../../utility/fs/FSReadStream');
const fs = require('fs-extra');

const HIGHWATER_MARK = 1024 * 1024 *3;

class TransactionStream extends FSReadStream{
    constructor(file_path, options, start_timestamp, end_timestamp){
        super(file_path, options, '\r\n');
        /*fs.stat(file_path).then(file_stat =>{


            this.start_timestamp = start_timestamp;
            this.end_timestamp = end_timestamp === undefined ? Date.now() : end_timestamp;
            this.results = [];
        });*/

    }

    onData(data){
        let lines = super.onData(data);

        let results = [];
        lines.forEach(row=>{
            if(row){
                let i = row.indexOf(',');
                let stamp = row.substr(0, i);
                if(this.between(stamp)){
                    results.push(row);
                }

            }

        });

        return results;
    }

    between(value){
        return value >= this.start_timestamp && value <= this.end_timestamp;
    }
}

module.exports = TransactionStream;