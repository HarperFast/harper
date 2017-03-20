const validate = require('validate.js');


var search_by_hash_constraints = {
    schema: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    table: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    hash_attribute: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    hash_value: {
        presence: true
    },
    get_attributes: {
        presence: true,
    }
};

var search_by_attribute_constraints = {
    schema: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    table: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    search_attribute: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    search_value: {
        presence: true
    },
    get_attributes: {
        presence: true,
    }
};




module.exports = function(search_object, type) {
     switch(type){
         case 'hash':
             return validate(search_object, search_by_hash_constraints);
         case 'attribute':
             return validate(search_object, search_by_attribute_constraints);
         case 'all':
             return validate(search_object, search_all_constraints);

     }
         
     
    // need to add validation to check if array for get attributes

};