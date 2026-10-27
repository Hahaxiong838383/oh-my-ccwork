const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(process.argv[2], 'utf8');
const api = source.slice(source.indexOf('async function api('), source.indexOf('// ========== 状态 =========='));
const del = source.slice(source.indexOf('async function deleteBalancer('), source.indexOf('async function saveBalancer('));
let restartCount = 0;
const toasts = [];
const sandbox = {
  fetch: async () => ({ok:false,status:409,json:async()=>({success:false,error:'managed configuration'})}),
  confirm: () => true,
  showToast: (...x) => toasts.push(x),
  restartXray: async () => { restartCount += 1; },
  canEditConfig: () => true,
  loadBalancers: () => {}, loadRoutes: () => {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(api + '\n' + del, sandbox);
(async () => {
  try { await vm.runInContext("deleteBalancer('managed-test')", sandbox); } catch (_) {}
  assert.equal(restartCount, 0, '409 must not restart Xray');
  assert(toasts.some(x => x[1] === 'error'), '409 must be visible as an error');
  assert(!toasts.some(x => x[1] === 'success'), '409 must not be presented as saved');
  console.log('PASS: rejected managed edit is visible and never restarts Xray');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
