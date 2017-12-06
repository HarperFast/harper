"use strict";

const wildcard_regex = /[\*%]/g;

let self = module.exports = {
    in: (value, compare_array) =>{
      return compare_array._data.indexOf(value) >= 0;
    },
    like:(value, compare_value)=>{
        let compare_regex = new RegExp(`^${compare_value.replace(/[\*%]/g, '.*?')}$`);
        return compare_regex.test(value);
    }
};
