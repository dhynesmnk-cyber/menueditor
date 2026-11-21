// jsPDF's node build does require('atob') / require('btoa') — the ancient
// standalone packages. Node has both as globals, so intercept the require
// instead of shipping node_modules shims or extra dependencies.
const Module = require('module');
const origLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === 'atob') {
    return (s) => Buffer.from(String(s), 'base64').toString('binary');
  }
  if (request === 'btoa') {
    return (s) => Buffer.from(String(s), 'binary').toString('base64');
  }
  return origLoad.apply(this, arguments);
};
