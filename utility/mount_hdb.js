
function mount(path){
    function makeDirectory(cur_path) {
        if (fs.existsSync(path)) {
            return;
        }

        fs.mkdirSync(cur_path);
        return;

    }
    if(fs.existsSync(path)){
        makeDirectory(path + "hdb");
        makeDirectory(path + "hdb/backup");
        makeDirectory(path + "hdb/log");
        makeDirectory(path + "hdb/config");
        makeDirectory(path + "hdb");





    }


}




