const ReverseFileRead = require('../../../utility/fs/ReverseFileRead');
const hdb_utils = require('../../../utility/common_utils');
const CHUNK_SIZE = 1024 *1024 * 5;
const LINE_DELIMITER = '\r\n';

class CatchUp extends ReverseFileRead{
    constructor(file_path, start_timestamp, end_timestamp){
        super(file_path, LINE_DELIMITER, CHUNK_SIZE);
        this.start_timestamp = start_timestamp;
        this.end_timestamp = hdb_utils.isEmpty(end_timestamp) === true ? Date.now(): end_timestamp;

        this.results = [];
    }

    evaluateData(data){
        let resume = true;
        data.reverse().forEach(row=>{
            if(row){
                let i = row.indexOf(',');
                let stamp = row.substr(0, i);
                resume = stamp > this.start_timestamp;

                if(this.between(stamp)){
                    resume = true;
                    let values = this.getValues(row, i);
                    if(values.length === 3) {
                        let result_object = {
                            timestamp: stamp,
                            __id: values[0],
                            operation: values[1],
                        };

                        if (values[1] === 'insert' || values[1] === 'update') {
                            result_object.records = values[2];
                        } else if (values[1] === 'delete') {
                            result_object.hash_values = values[2];
                        }

                        this.results.unshift(result_object);
                    }
                }
            }
        });

        return resume;
    }

    getValues(row, start){
        let values = [];
        let x = 0;
        let i = 0;
        try {
            do {
                i = row.indexOf(',', ++start);
                values.push(row.substr(start, i - start));
                start = i;
                x++;
            } while (x < 2);
            ++start;
            let json_string = row.substr(start, row.length - start);
            values.push(JSON.parse(json_string));
        } catch(e){
            console.error(e);
        }
        return values;
    }

    between(value){
        return value >= this.start_timestamp && value <= this.end_timestamp;
    }
}

module.exports = CatchUp;