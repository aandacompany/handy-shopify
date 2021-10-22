'use strict';

const path = require('path')
  ;


// insert routes here
module.exports = function(app){
  require(path.join(__dirname, 'get'))(app);
  require(path.join(__dirname, 'post'))(app);
}