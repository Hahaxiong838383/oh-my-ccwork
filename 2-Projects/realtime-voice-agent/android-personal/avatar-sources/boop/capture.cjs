// Bake the actual numbered materials into one static contact sheet for the picker.
// Run after build.mjs. Requires Playwright with Chromium and Python with Pillow.
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = path.resolve(__dirname,'../../assets/avatars/boop');
(async()=>{
  const work = await fs.mkdtemp(path.join(os.tmpdir(),'boop-stills-'));
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:896,height:64},deviceScaleFactor:1});
    await page.setContent('<style>*{box-sizing:border-box}body{margin:0;display:flex}.head{width:64px;height:64px;flex:none}</style>');
    await page.evaluate(()=>{window.NightAvatars={register(f){window.family=f;}};window.live=[];});
    await page.addScriptTag({path:path.join(out,'engine.js')});
    const count=await page.evaluate(()=>family.variants.length);
    for(let row=0;row<Math.ceil(count/14);row++){
      await page.evaluate(async start=>{
        for(const actor of live)actor.destroy();
        live=[];document.body.replaceChildren();
        for(const v of family.variants.slice(start,start+14)){
          const host=document.createElement('div');host.className='head';document.body.append(host);
          const actor=family.mount(host,v.id.startsWith('skin-') ? v.id+'-2d' : v.id);live.push(actor);
          actor.update({phase:'idle',state:'idle',reduced:true,color:'#5579e8',time:0});
        }
        for(let i=0;i<8;i++) await new Promise(requestAnimationFrame);
      },row*14);
      await page.screenshot({path:path.join(work,row+'.png'),omitBackground:true});
    }
    execFileSync('python3',['-c',[
      'import sys, pathlib','from PIL import Image',
      'folder=pathlib.Path(sys.argv[1]); atlas=Image.new("RGBA",(896,896))',
      'for img in folder.glob("*.png"): atlas.paste(Image.open(img),(0,int(img.stem)*64))',
      'for i in range(int(sys.argv[3])):',
      ' x,y=i%14*64,i//14*64; assert atlas.crop((x,y,x+64,y+64)).getchannel("A").getbbox(), f"Empty skin thumbnail {i}"',
      'atlas.save(sys.argv[2],"WEBP",quality=90,method=6)'
    ].join('\n'),work,path.join(out,'materials.webp'), String(count)]);
  } finally {await browser.close();await fs.rm(work,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
