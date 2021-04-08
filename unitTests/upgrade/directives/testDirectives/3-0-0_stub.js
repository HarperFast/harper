"use strict";
const upgrade_directive = require('../../../../upgrade/UpgradeDirective');

let this_ver = '3.0.0';
let directive = new upgrade_directive(this_ver);

directive.change_description = `Change descriptions for ${this_ver}`;

function updateSettingsFunc() {
    const msg = `processing settings func for ${this_ver} upgrade`;
    console.log(msg);
    return msg;
}
directive.settings_file_function.push(updateSettingsFunc);

function doSomething() {
    const msg = `processing other func for ${this_ver} upgrade`;
    console.log(msg);
    return msg;
}
directive.functions.push(doSomething);

function doSomething3_0_0() {
    const msg = `processing a second func for ${this_ver} upgrade`;
    console.log(msg);
    return msg;
}
directive.functions.push(doSomething3_0_0);

module.exports = directive;
