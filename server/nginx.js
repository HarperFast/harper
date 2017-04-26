let os = require('os')
let fs = require('fs')
let cp = require('child_process')
let type = 'nginx'

class Nginx {
    constructor () {
        process.title = 'node '+ type +' master'
        this.fork()
    }



    fork (id) {
        let cpus = os.cpus().length

        for (let i = 0; i < cpus; i++) {
            cp.fork('./'+ type +'-worker', {env: {id: i}})
        }
    }
}

new Nginx()
