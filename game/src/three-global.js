// three-global.js — the bridge between the vendored three.js and our ES modules.
//
// game/vendor/three.min.js is three.js r149's UMD build: it is loaded by a classic <script> tag
// before any module runs, and it publishes its namespace on the page's global object. Importing
// a UMD bundle as an ES module would give an empty namespace, so every module of the game takes
// THREE from here instead. One place, one job.

export const THREE = globalThis.THREE;

if (!THREE) {
  throw new Error('Canyon Courier: three.js did not load (vendor/three.min.js must run before src/main.js)');
}
