// Reproduce a PWA client that already cached old bytes under this version's URLs.
(async () => {
  try {
    const registration = await navigator.serviceWorker.register('/sw.js?v=' + expected.version);
    await navigator.serviceWorker.ready;
    const cache = await caches.open('codeg-assets-v1-' + expected.version);
    for (const path of Object.keys(expected.hashes)) await cache.put(path, new Response('old'));
    await fetch('/arm', {method:'POST'});
    const activated = new Promise((resolve, reject) => {
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') resolve();
          if (worker.state === 'redundant') reject(Error('Updated worker rejected the same-version cache'));
        });
      }, {once:true});
    });
    await registration.update();
    await activated;
    for (const [path, hash] of Object.entries(expected.hashes)) {
      const bytes = await (await cache.match(path)).arrayBuffer();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      if (Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('') !== hash)
        throw Error('Stale cached asset: ' + path);
    }
    await fetch('/result', {method:'POST', body:'PASS'});
  } catch (e) {
    await fetch('/result', {method:'POST', body:e.message});
  }
})();
