'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {runInNewContext} = require('node:vm');

const world = {window: {}};
for (const file of ['orb-reference.js', 'orb-motion.js']) {
  runInNewContext(readFileSync(join(__dirname, '../assets', file), 'utf8'), world);
}
const {GrokReference, NightOrbMotion} = world.window;
const phases = ['idle','connecting','reconnecting','waiting','listening','thinking','searching','reading',
  'speaking','streaming','muted','blocked','error'];
const dt = 1 / 60;
const create = () => NightOrbMotion.create(843);
function advance(motion, seconds, input) {
  let frame;
  for (let n = 0; n < Math.ceil(seconds / dt); n++) frame = motion.step(dt, input);
  return frame;
}
const geometry = f => [f.gazeX, f.gazeY, f.roll, f.scaleX, f.scaleY, f.lift, f.eyeOpenL, f.eyeOpenR];
const maxDistance = (a,b) => Math.max(...a.map((x,i) => Math.abs(x-b[i])));

test('distinct phase choreography, valid reference rings and non-label motion for each cue', () => {
  const names = new Set();
  for (const phase of phases) {
    const motion = create();
    const clips = new Map();
    for (let i=0; i<1800; i++) {
      const f = motion.step(dt, {phase, active: true});
      assert.equal(f.phase, phase);
      assert.ok(GrokReference.stateData[f.referenceState].expressions.includes(f.expression));
      assert.ok(f.expression >= 0 && f.expression < 25);
      assert.ok(geometry(f).every(Number.isFinite));
      if (!clips.has(f.clip)) clips.set(f.clip, {start:geometry(f), span:0});
      const clip = clips.get(f.clip);
      clip.span = Math.max(clip.span, maxDistance(clip.start,geometry(f)));
      names.add(f.clip);
    }
    assert.ok(clips.size >= 3, phase);
    for (const [name,c] of clips) assert.ok(c.span>0.003, phase+'/'+name);
  }
  assert.ok(names.size >= 45, String(names.size));
});

test('reference table retains its complete named face pools and expression variants', () => {
  const states = Object.keys(GrokReference.stateData);
  assert.equal(states.length, 39);
  const ids = new Set();
  for (const state of states) {
    const motion = create();
    const pool = GrokReference.stateData[state].expressions;
    for (let i = 0; i < 120; i++) {
      const f = motion.step(0.1, {phase:'thinking',referenceState:state,active:true});
      assert.equal(f.referenceState,state);
      assert.ok(pool.includes(f.expression));
      ids.add(f.expression);
    }
  }
  assert.ok(ids.size >= 20, 'drawn variants: '+ids.size);
});

test('state changes blend even at an interrupted mid-gesture; touch restores the current state', () => {
  const m = create();
  const before = advance(m, 0.85, {phase:'error'});
  const switched = m.step(dt, {phase:'listening',active:true});
  assert.ok(maxDistance(geometry(before),geometry(switched)) < 0.26);
  assert.ok(switched.expressionMix < 1);
  m.tap(-1,0.4);
  const tapped = advance(m, 0.32, {phase:'listening',active:true});
  assert.ok(tapped.clip.startsWith('tap-') && tapped.gazeX < -0.17 && tapped.accent > 0.4);
  const tucked = advance(m, 0.2, {phase:'listening',active:true});
  assert.equal(tucked.expression,6);
  const whileChanging = m.step(dt, {phase:'thinking',active:true});
  assert.ok(whileChanging.clip.startsWith('tap-'));
  const restored = advance(m, 1.1, {phase:'thinking',active:true});
  assert.equal(restored.referenceState,'thinking');
  assert.ok(!restored.clip.startsWith('tap-'));
});

test('speech articulation is measured and the listening microphone is isolated', () => {
  const a=create(), b=create();
  const quiet=advance(a,0.65,{phase:'speaking',active:true,mic:0.98,playback:0});
  const stressed=advance(b,0.65,{phase:'speaking',active:true,mic:0,playback:0.95});
  assert.equal(quiet.energy,0);
  assert.equal(quiet.articulation,'pause');
  assert.equal(stressed.articulation,'stress');
  assert.ok(stressed.energy>0.91 && stressed.scaleX-quiet.scaleX>.009 && Math.abs(stressed.scaleX/stressed.scaleY-1)<.025);
  const pause=advance(b,1.4,{phase:'speaking',active:true,playback:0});
  assert.equal(pause.energy,0);
  assert.equal(pause.articulation,'pause');
  assert.equal(advance(b,0.5,{phase:'listening',active:true,playback:1,mic:0}).energy,0);
  const mic=advance(b,0.5,{phase:'listening',active:true,mic:0.75});
  assert.ok(mic.energy>0.73 && mic.articulation==='attend');
  assert.equal(b.step(dt,{phase:'listening',active:true,muted:true,mic:1}).energy,0);
  assert.ok(advance(b,0.5,{phase:'streaming',active:true,muted:true,playback:0.65}).energy>0.64);
  assert.equal(b.step(dt,{phase:'speaking',active:false,playback:1}).energy,0);
});

test('reduced motion keeps a stable silhouette but still switches speech expressions', () => {
  const m=create();
  const before=advance(m,0.5,{phase:'speaking',active:true,reduced:true});
  const after=advance(m,10,{phase:'speaking',active:true,playback:0.8,reduced:true});
  assert.deepEqual(geometry(before),geometry(after));
  assert.equal(after.breath,0);
  assert.equal(after.accent,0);
  assert.equal(after.expressionMix,1);
  assert.ok(after.energy>0.79);
  // Silence before the first syllable settles into a hush face; playback
  // returns to a speaking group without any bob, blink or squash.
  assert.notEqual(before.expressionGroup,after.expressionGroup);
  assert.ok(after.expression>=0&&after.expression<25);
  const read=advance(m,1,{phase:'reading',reduced:true});
  assert.ok(read.gazeY>0.2 && read.energy===0);
});

test('one continuous utterance crosses several distinguishable expression families', () => {
  const run = (withCaption) => {
    const motion=create(), changes=[];
    let last=null;
    const pauses=[[2.30,2.58],[4.55,4.98],[6.86,7.14]];
    const cueAt=[0.55,2.85,5.15,7.25];
    const kinds=['explain','warm','question','concern'];
    for(let i=0;i<Math.ceil(9/dt);i++){
      const t=i*dt;
      const quiet=t<0.30 || pauses.some(([a,b])=>t>=a&&t<b);
      const syllable=Math.pow(Math.max(0,Math.sin(2*Math.PI*4.4*t)),1.6);
      const level=quiet?0:Math.min(1,.16+.66*syllable+(t>3.55&&t<4.05?.16:0));
      let cue=null;
      if(withCaption) for(let k=cueAt.length-1;k>=0;k--)
        if(t>=cueAt[k]){cue={kind:kinds[k],seq:k+1};break;}
      const f=motion.step(dt,{phase:'speaking',active:true,playback:level,speech:cue});
      if(last===null||f.expression!==last.expression){
        if(last!==null) changes.at(-1).end=t;
        changes.push({expression:f.expression,group:f.expressionGroup,source:f.expressionSource,start:t,end:t});
        last=f;
      }
    }
    return changes;
  };
  const caption=run(true);
  const audioOnly=run(false);
  for(const changes of [caption,audioOnly]) {
    const groups=new Set(changes.map(c=>c.group).filter(Boolean));
    assert.ok(groups.size>=3,'distinct expression families: '+[...groups].join(','));
    assert.ok(new Set(changes.map(c=>c.expression)).size>=3);
    const visible=changes.filter(c=>c.end-c.start>0.001);
    for(const change of visible.slice(1,-1)) assert.ok(change.end-change.start>=0.45,'held '+change.expression);
  }
  // A revealed caption is a local lexical estimate, not a provider label.
  const captioned=caption.filter(c=>c.source==='caption');
  assert.ok(captioned.length>=3);
  assert.ok(captioned.some(c=>c.group==='ask'));
  assert.ok(captioned.some(c=>c.group==='concern'));
});

test('the simulation is replayable from a seed and survives time gaps or invalid input', () => {
  const a=create(),b=create();
  for(const phase of phases) {
    const left=advance(a,1.4,{phase}),right=advance(b,1.4,{phase});
    assert.deepEqual(left,right);
  }
  for (const seconds of [-1,NaN,Infinity,80]) {
    const f=a.step(seconds,{phase:'other', mic:NaN, playback:Infinity});
    assert.equal(f.phase,'idle');
    assert.ok(geometry(f).every(Number.isFinite));
  }
});

test('speech blinks naturally and syllable counting survives different display refresh rates', () => {
  const rates = [30, 60, 120].map(hz => {
    const motion = create();
    let blinks = 0, shut = false, last;
    for (let i=0; i<8*hz; i++) {
      const pulse = Math.max(0, Math.sin(2*Math.PI*3.7*i/hz));
      last = motion.step(1/hz, {phase:'speaking', active:true, playback:.18+.56*pulse});
      if (!shut && last.eyeOpenL < .45 && last.eyeOpenR < .45) blinks++;
      shut = last.eyeOpenL < .45 && last.eyeOpenR < .45;
    }
    assert.ok(blinks >= 1 && blinks <= 3, hz+' Hz blinks '+blinks);
    return last.syllableRate;
  });
  assert.ok(rates.every(v => v>3 && v<4.5), 'onsets per second '+rates);
  assert.ok(Math.max(...rates)-Math.min(...rates)<.55);
});

test('the same voice level gives a held question a distinct tilt and an asymmetric gaze', () => {
  function pose(kind) {
    const m=create();
    advance(m,.65,{phase:'speaking',active:true,playback:.24});
    return advance(m,.34,{phase:'speaking',active:true,playback:.24,speech:{seq:1,kind}});
  }
  const question=pose('question'), stress=pose('emphasis');
  assert.ok(Math.abs(question.roll-stress.roll) > .12);
  assert.ok(Math.abs(question.eyeOpenL-question.eyeOpenR) > .15);
  assert.ok(Math.abs(question.eyeAimX-stress.eyeAimX) + Math.abs(question.gazeX-stress.gazeX) > .25);
});
