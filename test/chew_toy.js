try {
        const {spawn} = require('child_process');
        const node = spawn('node', [`--max-old-space-size=10000`, '..hdb_express.js']);

        node.stdout.on('data', (data) => {
            console.log(`stdout: ${data}`);
        });
        node.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
        });

        node.on('close', (code) => {
            console.log(`child process exited with code ${code}`);
        });

}catch(e){
    console.error(e);
}