
function getErrorMessage(err) {
  // standard version of JSON.stringify can't output Error type object
  return JSON.stringify(err, Object.getOwnPropertyNames(err));
}

module.exports = {
  getErrorMessage
};
