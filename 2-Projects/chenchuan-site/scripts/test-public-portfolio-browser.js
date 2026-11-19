// Run with playwright-cli run-code --filename=<this file>, on the public site.
// This is a read-only browser smoke test. It does not submit chat or admin forms.
async (page) => {
  const base = 'https://my.chenchuan.cc'
  if (!page.url().startsWith(base + '/')) throw new Error('Open the public portfolio first')
  const messages = []
  page.on('pageerror', error => messages.push({ type: 'pageerror', text: error.message }))
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) messages.push({ type: message.type(), text: message.text() })
  })
  const response = await page.goto(`${base}/work`)
  if (response.status() !== 200) throw new Error('Work index unavailable')
  const projectRoutes = await page.locator('main a[href^="/work/"]').evaluateAll(nodes => [...new Set(nodes.map(n => n.getAttribute('href')))])
  if (projectRoutes.length !== 15) throw new Error(`Expected 15 projects, got ${projectRoutes.length}`)
  await page.goto(`${base}/writing`)
  const articleRoutes = await page.locator('main a[href^="/writing/"]').evaluateAll(nodes => [...new Set(nodes.map(n => n.getAttribute('href')))])
  if (articleRoutes.length !== 4) throw new Error('Article routes changed')
  const routes = ['/', '/about', '/work', ...projectRoutes, '/writing', ...articleRoutes, '/videos', '/patents', '/contact', '/ai-os/chat']
  const checks = []
  const images = new Set()
  const videos = new Set()
  for (const route of routes) {
    const response = await page.goto(base + route, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(200)
    const state = await page.evaluate(() => ({
      title: document.title,
      overflow: document.documentElement.scrollWidth > innerWidth,
      text: document.body.innerText,
      images: [...document.querySelectorAll('main img')].map(n => n.currentSrc || n.src),
      videos: [...document.querySelectorAll('main video')].map(n => n.currentSrc || n.src),
      brokenLinks: [...document.querySelectorAll('a[href]')].filter(n => /yourprofile|your-wechat-id/.test(n.href)).map(n => n.href),
    }))
    if (response.status() !== 200 || state.overflow || state.brokenLinks.length) throw new Error(`Page failure: ${route} ${JSON.stringify({ status: response.status(), overflow: state.overflow, brokenLinks: state.brokenLinks })}`)
    // External live news is not authored portfolio copy; skip home ticker content.
    if (route !== '/' && /91\.5%|四引擎|零返工|几乎零延迟|4-6x|降维打击/.test(state.text)) throw new Error('Stale claim on '+route)
    if (route.startsWith('/work/') && !state.text.includes('技术：')) throw new Error('Missing visible stack on '+route)
    state.images.filter(url => url.startsWith(base)).forEach(url => images.add(url))
    state.videos.filter(url => url.startsWith(base)).forEach(url => videos.add(url))
    checks.push({ route, status: response.status(), overflow: state.overflow, title: state.title })
  }
  const assets = []
  for (const url of images) {
    const response = await page.request.get(url)
    if (response.status() !== 200) throw new Error('Image unavailable '+url)
    assets.push({ path: url.slice(base.length), status: response.status(), type: 'image' })
  }
  for (const url of videos) {
    const response = await page.request.get(url, { headers: { Range: 'bytes=0-1023' } })
    if (response.status() !== 206 || !response.headers()['content-type']?.includes('video/')) throw new Error('Video Range failed '+url)
    assets.push({ path: url.slice(base.length), status: response.status(), type: 'video' })
  }
  if (messages.length) throw new Error('Browser console messages require review')
  return { viewport: page.viewportSize(), pages: checks, assets, messages }
}
