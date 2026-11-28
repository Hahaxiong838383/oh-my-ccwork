// Tap the actual page and record the generated PCM at the speaker destination.
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = path.resolve(process.argv[2] || path.join(__dirname,'../build/assets'));
const origin = 'https://night.test/';

(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:412,height:850},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
    const errors = [];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route(origin+'**',route=>{
      const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      return route.fulfill({path:path.join(assets,name)});
    });
    await page.addInitScript(()=>{
      window.sounds=[];
      const start = AudioBufferSourceNode.prototype.start, connect = AudioBufferSourceNode.prototype.connect;
      AudioBufferSourceNode.prototype.connect=function(target,...args){
        this.speakerOnly = target === this.context.destination;
        return connect.call(this,target,...args);
      };
      AudioBufferSourceNode.prototype.start=function(...args){
        const b=this.buffer, wave=b.getChannelData(0), seconds=wave.length/b.sampleRate;
        const energy=Math.sqrt(wave.reduce((sum,v)=>sum+v*v,0)/wave.length);
        sounds.push({seconds,energy,speakerOnly:this.speakerOnly,ctx:this.context,
          start:wave[0], end:wave[wave.length-1]});
        return start.apply(this,args);
      };
    });
    await page.goto(origin);
    const box=()=>page.locator('#orb-canvas').boundingBox();
    const center=async()=>{const b=await box();return [b.x+b.width/2,b.y+b.height/2];};
    for (const [family,variant] of [['classic','night'],['open','controller'],['open','controller:glass'],['open','controller:flat'],['robot','rectangle'],
                                    ['boop','classic-3d'],['boop','classic-2d']]) {
      await page.locator('#btn-palette').click();
      await page.locator('[data-family='+family+']').click();
      await page.locator('.avatar-card[data-variant="'+variant+'"]').click();
      await page.locator('#appearance-done').click();
      // Wait for the selected material to mount and paint, including Boop's cross-fade.
      await page.waitForTimeout(550);
      const [x,y]=await center();
      const count=await page.evaluate(()=>sounds.length);
      await page.touchscreen.tap(x,y);
      await page.waitForFunction(n=>sounds.length===n+1,count,{timeout:3500}).catch(e=>{throw Error(family+'/'+variant+': '+errors.join(', ')+' '+e.message);});
      if (family === 'classic') {
        await page.touchscreen.tap(x,y);
        assert.equal(await page.evaluate(()=>sounds.length),count+1,'rapid taps are quiet');
      }
      await page.waitForTimeout(390);
      const c=await box(), corner=[c.x+c.width*.14,c.y+c.height*.14];
      await page.touchscreen.tap(...corner);
      await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+35,y+11,{steps:3}); await page.mouse.up();
      await page.touchscreen.tap(4,y);
      assert.equal(await page.evaluate(()=>sounds.length),count+1,family+' blank, drag and screen background');
    }
    const clips = await page.evaluate(()=>sounds.map(({seconds,energy,speakerOnly,start,end,ctx})=>
      ({seconds,energy,speakerOnly,start,end,closed:ctx.state==='closed'})));
    assert.equal(new Set(clips.map(c=>Math.round(c.seconds*1000))).size,4,'four distinct sound lengths');
    for (const c of clips) {
      assert.ok(c.speakerOnly && c.closed);
      assert.ok(c.energy>.003 && c.energy<.1 && Math.abs(c.start)<.001 && Math.abs(c.end)<.001);
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify(clips.map(c=>[Math.round(c.seconds*1000),Number(c.energy.toFixed(4))])));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
