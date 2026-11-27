// Inspect what is actually painted under the sphere, in CSS pixels.
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = path.resolve(process.argv[2] || path.join(__dirname, '../assets'));

(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH, args:['--no-sandbox']});
  try {
    const page = await browser.newPage({deviceScaleFactor:2});
    await page.setContent('<canvas></canvas>');
    for (const file of ['orb-reference.js','orb-motion.js','orb-surface.js']) {
      await page.addScriptTag({path:path.join(assets,file)});
    }
    for (const size of [58, 212, 304]) {
      const data = await page.evaluate(size => {
        const canvas = document.querySelector('canvas');
        canvas.style.width = canvas.style.height = size+'px';
        const orb = new NightSphere(canvas,'#4F7DF3',843);
        const render = (level, frames=50) => {
          orb.setLevel(level);
          for (let i=0; i<frames; i++) orb.render(1/60);
          const ctx = canvas.getContext('2d'), {width:w,height:h} = canvas;
          const rgba = ctx.getImageData(0,0,w,h).data;
          return [-2,-1,0,1,2].map(i => {
            const x = Math.floor((size/2+i*12*Math.min(1,size/228))*w/size);
            let count=0, light=0;
            for (let y=Math.ceil(.90*h); y<h; y++) {
              const at=(y*w+x)*4;
              if (rgba[at]>100 && rgba[at+3]>12) { count++; light+=rgba[at+3]; }
            }
            return {height:count*size/h, light};
          });
        };
        orb.setState('listening',true,false); orb.micTarget=1;
        const listening=render(0);
        orb.setState('speaking',true,true);
        const quiet=render(0), soft=render(.16), loud=render(.85), pause=render(0,65);
        orb.setState('listening',true,false); const interrupt=render(.9,1);
        orb.setState('speaking',true,false); const next=render(0,1);
        return {listening,quiet,soft,loud,pause,interrupt,next};
      }, size);
      const center = a => a[2].height;
      assert.equal(center(data.listening),0);
      assert.ok(center(data.loud)>center(data.soft) && center(data.soft)>center(data.quiet));
      assert.ok(data.loud[2].height>data.loud[1].height && data.loud[1].height>=data.loud[0].height);
      assert.deepEqual(data.pause,data.quiet);
      assert.ok(data.interrupt.every(mark=>mark.height===0));
      assert.deepEqual(data.next,data.quiet);
      console.log(size+'px sphere, center pulse, silent / soft / loud (CSS px):', ...[data.quiet,data.soft,data.loud].map(center));
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    const samples = await page.evaluate(() => {
      const canvas=document.querySelector('canvas'), orb=new NightSphere(canvas,'#242424',3);
      orb.setState('speaking',true,false);
      return [0,.8].map(level => {
        orb.setLevel(level);
        for (let i=0;i<100;i++) orb.render(1/60);
        const w=canvas.width, h=canvas.height;
        const data=canvas.getContext('2d').getImageData(w/2,Math.ceil(.90*h),1,Math.floor(.10*h)).data;
        const alpha=Array.from(data).filter((_,i)=>i%4===3);
        return {rows:alpha.filter(a=>a>10).length, brightness:Math.max(...alpha)};
      });
    });
    assert.equal(samples[0].rows,samples[1].rows);
    assert.ok(samples[1].brightness>samples[0].brightness+70);
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
