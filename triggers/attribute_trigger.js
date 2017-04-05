'use strict';
const fs = require('fs')
    , settings = require('settings')
    , base_path = settings.HDB_ROOT + "/schema/"
    , exec = require('child_process').exec
    , search_validator = require('../validation/searchValidator.js')
    , async = require('async')
    , spawn = require('child_process').spawn
    , util = require('util')
    , schema = require('../data_layer/schema')
    , insert = require('../data_layer/insert.js')
    , search = require('../data_layer/search.js');


function initialize(){




}