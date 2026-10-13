// Loads the extension's UMD files as CommonJS. The repo root package.json says
// "type": "module", so a bare require() of extension/*.js evaluates them as ESM
// and returns an empty namespace (crypto.js has the same property); evaluating
// the source ourselves with a CJS-shaped `module` is what the UMD wrapper wants.
"use strict";
var fs = require("node:fs");
var path = require("node:path");

var DRIVE = process.env.HYD_DRIVE || path.resolve(__dirname, "..");
var EXT = path.resolve(__dirname, "../..");
var cache = {};

function loadFile(file) {
  file = path.resolve(file);
  if (cache[file]) return cache[file].exports;
  var m = { exports: {} };
  cache[file] = m;
  var dir = path.dirname(file);
  var req = function (id) {
    if (id.charAt(0) === ".") return loadFile(path.resolve(dir, id));
    return require(id);
  };
  var src = fs.readFileSync(file, "utf8");
  new Function("module", "exports", "require", src).call(m.exports, m, m.exports, req);
  return m.exports;
}

module.exports = {
  drive: function (name) { return loadFile(path.join(DRIVE, name)); },
  ext: function (name) { return loadFile(path.join(EXT, name)); },
  file: loadFile,
  here: function (name) { return loadFile(path.join(__dirname, name)); },
  DRIVE: DRIVE,
};
