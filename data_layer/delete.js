const fs = require('fs')
    ,settings = require('settings')
    ,validate = require('validate.js')
    ,insert = require('./insert.js')
    ,table_validation = require('../validation/table_validation.js')
    ,exec = require('child_process').exec
    ,search =require('search.js');


module.exports ={
  delete: function(delete_object){
      var search_obj = {};
      search_obj.schema = 'dev';
      search_obj.table = 'person';
      search_obj.hash_attribute = 'id';
      search_obj.hash_values = [];
      search_obj.get_attributes = ['id', 'first_name', 'last_name'];



  }

};