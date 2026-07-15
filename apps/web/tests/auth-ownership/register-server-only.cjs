/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require("node:module");

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveServerOnly(request, parent, isMain, options) {
  if (request === "server-only") return __filename;
  return resolveFilename.call(this, request, parent, isMain, options);
};
