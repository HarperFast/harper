const FSReadStream = require('./FSReadStream');

class TransactionStream extends FSReadStream{
    constructor(file_path, options){
        super(file_path, options, '\r\n');
        this.recs = 0;
    }

    onData(data){
        let lines = super.onData(data);

        let rex = [];
        lines.forEach(row=>{
            if(row){
                let i = row.indexOf(',');
                let stamp = row.substr(0, i);
                rex.push(row);
            }

        });
        this.recs += rex.length;
        return rex;
    }
}

module.exports = TransactionStream;