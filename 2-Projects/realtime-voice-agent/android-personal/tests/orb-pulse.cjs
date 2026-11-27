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
          const {cx,rx,ry,cos,sin}=orb.geometry;
          const radius=Math.hypot(rx*cos,ry*sin), columns=[];
          for(let x=0;x<w;x++){
            let rows=0, alpha=0;
            for(let y=Math.ceil(.90*h);y<h;y++){
              const at=(y*w+x)*4;
              if(rgba[at]>100 && rgba[at+3]>3){rows++;alpha=Math.max(alpha,rgba[at+3]);}
            }
            columns.push({x:(x+.5)*size/w,height:rows*size/h,alpha});
          }
          const lit=columns.filter(c=>c.alpha>0);
          const inBand=(low,high)=>columns.filter(c=>{
            const u=Math.abs(c.x-cx)/radius;return u>=low && u<=high;
          });
          const height=(low,high)=>Math.max(0,...inBand(low,high).map(c=>c.height));
          const alpha=(low,high)=>Math.max(0,...inBand(low,high).map(c=>c.alpha));
          return {center:height(0,.15),middle:height(.4,.6), centerAlpha:alpha(0,.15),
            edgeAlpha:alpha(.76,.88),tipAlpha:alpha(.985,1.03),
            widthRatio:lit.length ? (lit.at(-1).x-lit[0].x)/(2*radius) : 0};
        };
        orb.setState('listening',true,false); orb.micTarget=1;
        const listening=render(0);
        orb.setState('speaking',true,true);
        const quiet=render(0), soft=render(.16), loud=render(.85), pause=render(0,65);
        orb.setState('listening',true,false); const interrupt=render(.9,1);
        orb.setState('speaking',true,false); const next=render(0,1);
        return {listening,quiet,soft,loud,pause,interrupt,next};
      }, size);
      assert.equal(data.listening.center,0);
      assert.ok(data.loud.center>data.soft.center && data.soft.center>data.quiet.center);
      assert.ok(data.loud.center>data.loud.middle);
      assert.ok(data.loud.widthRatio>.82 && data.loud.widthRatio<=1.02,JSON.stringify(data.loud));
      assert.ok(data.loud.centerAlpha>data.loud.edgeAlpha && data.loud.edgeAlpha>data.loud.tipAlpha);
      assert.ok(data.loud.tipAlpha<10);
      assert.ok(Math.abs(data.pause.center-data.quiet.center)<=1);
      assert.equal(data.interrupt.widthRatio,0);
      assert.ok(Math.abs(data.next.center-data.quiet.center)<=1);
      console.log(size+'px canvas:',JSON.stringify(data.loud));
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
