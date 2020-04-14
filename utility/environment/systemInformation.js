'use strict';

const si = require('systeminformation');

async function getHardwareInfo(){
    let hardware_info = await si.getAllData();
    console.log(hardware_info);
}

getHardwareInfo().then(()=>{});