// 生成 8 张场景卡的 gpt-image-2 prompt 文件
// 一致性锚点：与新手引导专注/夜航底图 boarding/ecopond.png 同一艘飞船（同款舱室 DNA），
// 让小朋友感知"始终在同一艘方舟上"。8 张只是这艘船的不同角落/时刻，建筑语言完全一致。
// 用法：node scripts/gen-scene-prompts.mjs → 写出 /tmp/scene-prompt-cardN.txt
import { writeFileSync } from 'node:fs';

// 「同一艘船」DNA —— 提取自 ecopond.png（专注引导 + 夜航报告引导的实际底图），
// 每张必须复刻这套舱室建筑语言，确保视觉连续性。
const SHIP_DNA = [
  'CRITICAL CONSISTENCY — every image must read as the SAME single warm, magical spaceship cabin (the "Ark"),',
  'so a child instantly feels "I am still on the same ship". Replicate this exact interior design language in EVERY scene:',
  '(1) a signature LARGE CIRCULAR porthole window with a thick glowing GOLDEN rim, looking out to deep-navy starry space;',
  '(2) dominant WARM GOLDEN / amber lighting; glowing golden curved metallic wall panels with rounded sci-fi paneling;',
  '(3) plenty of floating warm-golden bokeh light particles / firefly sparkles drifting in the air;',
  '(4) a round central floor platform with concentric golden trim lines and soft reflections on a cream-gold floor;',
  '(5) lush green vines and small potted plants draping in from the sides;',
  '(6) warm, dreamy, fairy-tale sci-fi mood — a cozy living home, NOT cold hard tech, never bluish-cold.',
].join(' ');

const STYLE = [
  'Soft 3D cartoon render, Pixar / pop-mart blind-box aesthetic, children-friendly (ages 6-13).',
  'Wide cinematic horizontal composition (3:2). Clean and uncluttered.',
  'NO characters, NO robot, NO cat, NO people anywhere. Environment / set only.',
  'Keep the LOWER-RIGHT third of the frame visually open and empty (a mascot will be overlaid there later).',
  'NO text, NO letters, NO numbers, NO UI buttons, NO watermark, NO logo.',
].join(' ');

// 每张 = 同一艘船的不同角落/时刻，只换该场景的「功能陈设」，建筑/舷窗/地台/灯光/绿植不变
const SCENES = {
  card1: 'WELCOME moment (登舰破冰): the same cabin at the joyful first arrival. Through the signature golden-rim circular porthole shines a beautiful blue EARTH in space (the ship just set off). On the round central floor platform sits a festive golden gift box with a ribbon bow (the welcome gift). Extra-dense cheerful golden confetti sparkles — the brightest, warmest, most welcoming moment of the ship.',
  card2: 'NIGHT-VOYAGE report (夜航呼唤): the same cabin after returning from a night voyage. To the left, a glowing settlement console / pile of collected treasure and supplies on the platform, with streams of golden STARDUST particles flowing in from the porthole. Deeper night tone but still warm-golden, magical rewarding "just came home" mood.',
  card3: 'RETURNING back (回归承接): the same cabin featuring the built-in green ECOSYSTEM TANK (aquarium) on the left exactly like the reference, glowing softly with water plants and a few little glowing fish that have grown something new. Warm reunion glow, the welcoming "you can pick right back up" feeling.',
  card4: 'SHARED MEMORY (记忆复现): a cozy corner of the same cabin in soft sunset-warm light through the golden-rim porthole. Beside the platform, a low golden shelf holds cherished keepsakes — a little dinosaur plush toy, a small framed photo, collected trinkets — softly lit, nostalgic and tender.',
  card5: 'IDEA WALL (KidsHub 情绪回应): one curved golden wall of the same cabin turned into a glowing wall of floating luminous idea-bubbles and star-shaped sticky notes drifting in the air, the signature circular porthole still visible beside it. Hopeful, uplifting, "ideas are heard and treasured" mood, still warm-gold.',
  card6: 'BEDTIME teaser (关机预告): the same cabin at night just before sleep, the warm-golden lights dimmed low, the circular porthole full of stars, the ecosystem tank keeping one gentle lingering glow as tomorrow\'s hook, sparser floating sparkles. Peaceful, calm, cozy "good night" atmosphere.',
  card7: 'FOCUS desk (坐姿吐槽转正): a focused reading-and-writing corner of the same cabin — a clean desk with books and stationery set near the central platform, a soft glowing golden reminder ring of light around the seat, the golden-rim porthole behind. Relaxed, friendly, non-preachy study mood.',
  card8: 'STANDBY console (设备查询与误唤醒): a control-console section built into the same cabin\'s golden curved wall, with warm skeuomorphic dials and softly glowing amber indicator lights (suggesting brightness / color-temperature / volume, but NO numbers or text), the signature circular porthole beside it. Minimal, tidy, warm-gold, the ship quietly waiting on call — never cold blue.',
};

for (const [id, scene] of Object.entries(SCENES)) {
  const prompt = `${scene}\n\n${SHIP_DNA}\n\n${STYLE}`;
  const path = `/tmp/scene-prompt-${id}.txt`;
  writeFileSync(path, prompt);
  console.log(`wrote ${path}`);
}
