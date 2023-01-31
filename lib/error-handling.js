
function getErrorMessage(err) {
  // check for error type and print as string due to JSON.stringify can't print it
  if (err && err.stack && err.message){
    // print to String
    return String(err);
  }

  return JSON.stringify(err);
}

module.exports = {
  getErrorMessage
};
