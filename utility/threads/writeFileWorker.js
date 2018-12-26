const Pool = require('threads').Pool;

module.exports = async function runner(chunks) {
    let pool = new Pool();
    pool.run(worker);

    await Promise.all(
        chunks.map(async chunk => {
            await pool.send(chunk).promise();
        })
    );

    pool.killAll();
};

async function worker(files){
    const fs = require('fs-extra');
    await Promise.all(
        files.map(async (file)=>{
            try {
                await fs.writeFile(file.path, file.data);
            } catch(e){
                console.error(e);
            }
        })
    );
}

