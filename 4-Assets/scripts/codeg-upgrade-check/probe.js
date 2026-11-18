// Exercise the two settings-page API methods against their shipped WebTransport.
(async () => {
  const report = window.fetch.bind(window);
  let transport;
  const exports = {};
  function loadExport(name) {
    const factories = [...new Set(window.TURBOPACK.flat().filter(x =>
      typeof x === "function" && x.toString().includes('"' + name + '",0,')))];
    if (factories.length !== 1) throw Error('Unsupported settings bundle: ' + name);
    const dependency = new Proxy({}, {get: (_, key) =>
      key === 'getTransport' ? () => transport : () => ({})});
    factories[0]({i: () => dependency, s(items) {
      for (let i = 0; i < items.length; i += 3) exports[items[i]] = items[i + 2];
    }});
    if (!exports[name]) throw Error('Missing export ' + name);
  }
  try {
    loadExport('WebTransport');
    loadExport('acpPrepareNpxAgent');
    transport = new exports.WebTransport(location.origin);
    const handlers = new Set();
    transport.handlers.set('app://agent-install', handlers);
    const timers = new Map();
    let now = 0, next = 0, pending;
    window.setTimeout = (fn, delay) => {
      timers.set(++next, {fn, due: now + delay});
      return next;
    };
    window.clearTimeout = id => timers.delete(id);
    window.fetch = async (url, options) => {
      if (pending) throw Error('Unexpected parallel request');
      pending = {url, signal: options.signal, args: JSON.parse(options.body)};
      return new Promise((_, reject) => options.signal.addEventListener('abort',
        () => reject(new DOMException('aborted', 'AbortError')), {once: true}));
    };
    function advance(ms) {
      now += ms;
      for (const [id, timer] of timers) if (timer.due <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
    function requireBehavior(ok, reason) {
      if (!ok) throw Error('TIMEOUT REGRESSION: ' + reason);
    }
    for (const [rpc, start] of [
      ['acp_prepare_npx_agent', () => exports.acpPrepareNpxAgent('deepseek', null, 'mine')],
      ['acp_download_agent_binary', () => exports.acpDownloadAgentBinary('cursor', 'mine')]
    ]) {
      pending = undefined;
      const result = start().then(() => 'resolved', e => e.message);
      if (!pending?.url.endsWith('/api/' + rpc) || pending.args.taskId !== 'mine')
        throw Error('Unsupported RPC invocation: ' + rpc);
      advance(61000);
      requireBehavior(!pending.signal.aborted, rpc + ' aborted after 60 seconds');
      advance(830000);
      requireBehavior(!pending.signal.aborted, rpc + ' aborted before 15 minutes');
      for (const fn of handlers) fn({task_id:'mine', kind:'log', payload:'Downloaded 1 MB'});
      advance(890000);
      requireBehavior(!pending.signal.aborted, rpc + ' ignored matching progress');
      for (const fn of handlers) fn({task_id:'other', kind:'log', payload:'Downloaded 2 MB'});
      advance(10001);
      requireBehavior(pending.signal.aborted, rpc + ' failed to expire on inactivity');
      if (await result !== 'Request timed out' || handlers.size || timers.size)
        throw Error('Unexpected timeout cleanup: ' + rpc);
    }
    pending = undefined;
    const ordinary = exports.acpListAgents().then(() => 'resolved', e => e.message);
    if (!pending?.url.endsWith('/api/acp_list_agents')) throw Error('Missing ordinary RPC control');
    advance(59999);
    if (pending.signal.aborted) throw Error('Ordinary API timed out early');
    advance(2);
    if (!pending.signal.aborted || await ordinary !== 'Request timed out')
      throw Error('Ordinary API deadline changed');
    await report('/result', {method:'POST', body:'PASS'});
  } catch (e) {
    await report('/result', {method:'POST', body:String(e.message)});
  }
})();
