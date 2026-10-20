/* schema-retry.js — on the FIRST start of a new database the modules prepare their tables at the same time, so one can
   try to alter a table another has not created yet ("relation ... does not exist"). This waits a moment and tries
   again (up to ~10 s) instead of giving up until the next restart. Any other error is thrown straight away. */
const MISSING = ['42P01', '42703'];          // undefined_table, undefined_column
module.exports = async function retryWhileMissing(fn, tries = 7, waitMs = 1500) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (err) { if (i >= tries - 1 || !MISSING.includes(err.code)) throw err; await new Promise((r) => setTimeout(r, waitMs)); }
  }
};
