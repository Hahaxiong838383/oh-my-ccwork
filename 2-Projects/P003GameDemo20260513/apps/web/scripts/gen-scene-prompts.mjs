// 生成 8 张场景卡的 gpt-image-2 prompt 文件
// 统一风格 = 新手引导 boarding（暖金科幻飞船舱 3D 卡通），无小可角色，右下留白给 avatar
import { writeFileSync } from 'node:fs';

const STYLE = [
  'Soft 3D cartoon render, Pixar / pop-mart blind-box aesthetic, children-friendly (ages 6-13).',
  'Setting: the interior of a cozy futuristic "Ark" spaceship cabin.',
  'Palette: deep navy blue + warm gold, gentle ambient glow, soft rim light, dreamy bokeh light particles.',
  'Wide cinematic horizontal composition (3:2). Clean and uncluttered.',
  'IMPORTANT: NO characters, NO robot, NO cat, NO people anywhere. Environment / set only.',
  'IMPORTANT: keep the LOWER-RIGHT third of the frame visually open and empty (a mascot will be overlaid there later).',
  'NO text, NO letters, NO numbers, NO UI buttons, NO watermark, NO logo.',
].join(' ');

const SCENES = {
  card1: '登舰破冰 / boarding welcome: a bright, warm, joyful spaceship cabin interior on the FIRST arrival. A big rounded porthole window on the upper-left reveals a beautiful blue Earth in space. On the left floor, a festive golden gift box with a ribbon bow (the "welcome gift"), gentle confetti light sparkles in the air. The brightest, most cheerful and inviting scene of the set.',
  card2: '夜航呼唤 / night-voyage report: a deep-blue night-voyage settlement cabin, the porthole reveals deep starry space, the Ark has just returned from its night voyage. On the left, a glowing resource-settlement console / pile of collected supplies, with streams of golden stardust particles flowing toward it. Quiet "just came home from the voyage" mood, magical and rewarding.',
  card3: '回归承接 / returning back: a warm ecosystem-tank (aquarium) as the visual centerpiece on the left, glowing softly with water plants and a few little glowing fish swimming, hinting at "something new grew while you were away". Warm reunion lighting, soft glow from a small porthole. Welcoming, gentle, "you can pick right back up" feeling.',
  card4: '记忆复现 / shared memory: a cozy intimate corner of the cabin bathed in soft sunset-warm light. A low shelf / small table holds a few cherished personal keepsakes — a little dinosaur plush toy, a small framed photo, collected trinkets — softly lit, hinting at "remembered things". Nostalgic, tender, private and warm atmosphere.',
  card5: 'KidsHub 情绪回应 / idea wall: an inspiration-collection bay, a glowing wall of floating luminous idea-bubbles and softly glowing star-shaped sticky notes drifting in the air, blue-and-gold tech wall. Conveys "ideas are heard and treasured", hopeful uplifting techy-warm mood.',
  card6: '关机预告 / bedtime teaser: the cabin at night just before closing the lid, interior lights dimming to a warm amber, the porthole reveals a full sky of stars. One small element keeps a gentle lingering glow (the ecosystem tank or a small object) as tomorrow\'s hook. Peaceful, calm, "good night, come back tomorrow" bedtime atmosphere.',
  card7: '坐姿吐槽转正 / focus desk: a focused reading-and-writing desk environment inside the cabin, a clean desk surface with books and stationery, a soft gentle glowing reminder ring of light around the seating area. Relaxed and non-preachy, friendly cozy study mood, NOT strict.',
  card8: '设备查询与误唤醒 / standby console: a clean spaceship control console / instrument area at calm standby, with skeuomorphic dials and softly glowing indicator lights suggesting brightness / color-temperature / volume gauges (NO numbers or text on them). Minimal, tidy, ready-on-call tech feeling, the device quietly waiting.',
};

for (const [id, scene] of Object.entries(SCENES)) {
  const prompt = `${scene}\n\n${STYLE}`;
  const path = `/tmp/scene-prompt-${id}.txt`;
  writeFileSync(path, prompt);
  console.log(`wrote ${path}`);
}
