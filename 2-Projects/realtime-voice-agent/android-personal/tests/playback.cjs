// Use the bundled LiveKit participant/publication events and real browser audio.
// Only signalling, Android permissions and the synthetic microphone are local fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = path.resolve(process.argv[2] || path.join(__dirname, '../assets'));
const sdkPath = process.env.LIVEKIT_UMD || path.resolve(__dirname, '../../web/personal/node_modules/livekit-client/dist/livekit-client.umd.js');

(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,
    args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
  try {
    const page = await browser.newPage();
    const html = (await fs.readFile(path.join(assets, 'index.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link[^>]*>/gi, '');
    await page.route('http://localhost:13972/', route => route.fulfill({body:html,contentType:'text/html'}));
    await page.goto('http://localhost:13972/');
    await page.addScriptTag({path:sdkPath});
    await page.evaluate(() => {
      const sdk = window.LivekitClient;
      const info = {identity:'agent-test',sid:'PA_test',kind:sdk.ParticipantKind.AGENT,state:2,version:1,attributes:{},
        tracks:[{type:0,source:2,sid:'TR_voice',name:'agent-voice',layers:[],codecs:[]}]};
      window.events = [];
      window.NightView = {render(s){ window.display=s; document.getElementById('status-banner').hidden=!s.status; },level(){}};
      window.NightHost = {paired:()=>true,event:e=>events.push(e),setCall(){},
        micPermission:id=>queueMicrotask(()=>Voice.onPermission(id,true)),
        ticket:id=>queueMicrotask(()=>Voice.onTicket(id,{url:'wss://pa.hahaxiong.cc:8666',token:'fixture'}))};
      window.setName = name => {
        info.attributes = name ? {'lk.agent.name':name} : {};
        room.getOrCreateParticipant(info.identity,{...info,version:++info.version});
      };
      window.makeTrack = () => {
        const stream = toneDestination.stream;
        return new sdk.RemoteAudioTrack(stream.getAudioTracks()[0].clone(),'TR_voice',undefined);
      };
      window.LivekitClient = {...sdk,Room:class extends sdk.Room {
        constructor(opts) {
          super(opts);
          window.room=this;
          this.connect=async()=>{
            this.setAndEmitConnectionState(sdk.ConnectionState.Connected);
            window.toneCtx=new AudioContext();
            await toneCtx.resume();
            window.toneDestination=toneCtx.createMediaStreamDestination();
            const oscillator=toneCtx.createOscillator();
            oscillator.connect(toneDestination); oscillator.start();
            window.peer=this.getOrCreateParticipant(info.identity,info);
            peer.updateInfo(info);
            window.pub=peer.audioTrackPublications.get('TR_voice');
            pub.setTrack(makeTrack());
          };
          this.disconnect=async()=>{};
          this.localParticipant.setMicrophoneEnabled=async()=>{};
          this.localParticipant.publishData=async (data,options)=>{
            if(options.topic!=='personal.v1.input')return;
            const {id}=JSON.parse(new TextDecoder().decode(data));
            queueMicrotask(()=>this.emit(sdk.RoomEvent.DataReceived,new TextEncoder().encode(JSON.stringify({type:'ready',voice:true,id})),peer,0,'personal.v1.output'));
          };
        }
      }};
    });
    await page.addScriptTag({path:process.env.SESSION_JS || path.join(assets,'session.js')});
    await page.evaluate(()=>Voice.start());
    assert.equal(await page.locator('audio').count(),0,'unverified worker must stay silent');
    await page.evaluate(()=>setName('other-worker'));
    assert.equal(await page.locator('audio').count(),0,'incorrect worker must stay silent');
    await page.evaluate(()=>setName('personal-xiaoke'));
    await page.waitForFunction(()=>events.includes('connected'),null,{timeout:3500});
    assert.equal(await page.locator('audio').count(),1,'already-subscribed track must attach when worker attributes arrive');
    await page.waitForFunction(()=>events.includes('rx_audio') && !document.querySelector('audio')?.paused,null,{timeout:4000});
    await page.evaluate(()=>{window.first=document.querySelector('audio'); room.emit(LivekitClient.RoomEvent.Reconnected);});
    assert(await page.evaluate(()=>document.querySelector('audio')===window.first),'repeat reconciliation must preserve playback');
    await page.evaluate(()=>{pub.setTrack(undefined);});
    assert.equal(await page.locator('audio').count(),0,'old publication must be detached');
    // The SDK buffers participant changes during reconnect. Model a subscribed publication
    // already present when the app receives Reconnected, with no TrackSubscribed replay.
    await page.evaluate(()=>{
      room.emit(LivekitClient.RoomEvent.Reconnecting);
      const handlers=room.listeners(LivekitClient.RoomEvent.TrackSubscribed);
      for(const fn of handlers)room.off(LivekitClient.RoomEvent.TrackSubscribed,fn);
      pub.setTrack(makeTrack());
      for(const fn of handlers)room.on(LivekitClient.RoomEvent.TrackSubscribed,fn);
      room.emit(LivekitClient.RoomEvent.Reconnected);
    });
    assert.equal(await page.locator('audio').count(),1,'reconnected room must attach the existing publication');
    await page.evaluate(()=>setName(''));
    assert.equal(await page.locator('audio').count(),0,'losing worker identity must stop playback');
    await page.evaluate(()=>{
      const proto=HTMLMediaElement.prototype;
      const original=proto.play, autoplay=Object.getOwnPropertyDescriptor(proto,'autoplay');
      Object.defineProperty(proto,'autoplay',{...autoplay,set(){autoplay.set.call(this,false);}});
      window.restorePlay=()=>{proto.play=original;Object.defineProperty(proto,'autoplay',autoplay);};
      HTMLMediaElement.prototype.play=function(){return Promise.reject(new DOMException('fixture','NotAllowedError'));};
      setName('personal-xiaoke');
    });
    const retry=page.getByRole('button',{name:'恢复声音'});
    await retry.waitFor({timeout:2500});
    await page.waitForTimeout(1300);
    assert(await retry.isVisible(),'playback rejection must survive a health poll');
    await page.evaluate(()=>restorePlay());
    await retry.click();
    await page.waitForFunction(()=>!document.querySelector('audio').paused && ![...document.querySelectorAll('button')].some(b=>b.textContent==='恢复声音' && !b.hidden));
    await page.evaluate(()=>Voice.stop());
    assert.equal(await page.locator('audio').count(),0);
    console.log('PASS early subscription, identity gate/revocation, PCM playback, stable element, reconnect recovery, gesture retry, teardown');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
