// Makes `@google-cloud/firestore` unresolvable, as on a CI runner where firebase-admin's
// optional Firestore dependency is not installed (Node 20). firebase-admin loads it with require().
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@google-cloud/firestore' || request.startsWith('@google-cloud/firestore/')) {
    throw Object.assign(new Error("Cannot find module '@google-cloud/firestore'"), { code: 'MODULE_NOT_FOUND' });
  }
  return resolve.call(this, request, ...rest);
};
