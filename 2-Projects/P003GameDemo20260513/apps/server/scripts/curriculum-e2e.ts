/**
 * L_curriculum 真实 LLM E2E：对比小可在「老师讲了分数没懂」这轮，
 * baseline（无护栏）vs treatment（+KG 先修护栏）的真实回答差异。用小可真实 LLM client（gemini-llm.ts）。
 * 跑法（需有效 GEMINI key）：set -a; source .env.local; set +a; npx tsx scripts/curriculum-e2e.ts
 * 验收点：treatment 应——用孩子懂的例子 / 不报菜名 / 不说"先修·超纲"黑话 / 可能先确认先修 / 自然过渡语。
 */
import { createGeminiLlmClient } from '../src/providers/gemini-llm.js';
import { curriculumKG } from '../src/curriculum-kg.js';
import { assembleSystemPrompt } from '../src/prompt-orchestrator.js';

const BASE =
  '你是儿童陪伴机器人小可（K1）。用户是 5-12 岁孩子，叫他"指挥官"。语气温暖、活泼、有耐心。' +
  '日常聊天保持简短自然（30-50 字）；如果指挥官请你讲故事、科普知识、详细解释，可以讲完整（200-500 字，分段叙述）。' +
  '不要刻意凑字数，自然就好。';

const USER = '老师今天讲了分数，我没听懂，分数到底是什么呀';

function run(guardrail: string | null): Promise<string> {
  const systemPrompt = assembleSystemPrompt(BASE, null, null, guardrail);
  const llm = createGeminiLlmClient();
  let out = '';
  return new Promise((resolve, reject) => {
    llm.streamChat({
      systemPrompt,
      userText: USER,
      history: [],
      onDelta: (d: string) => {
        out += d;
      },
      onDone: () => resolve(out),
      onError: (e: Error) => reject(e),
    });
  });
}

async function main() {
  const guardrail = curriculumKG.buildGuardrail(USER);
  console.log('护栏命中:', guardrail ? guardrail.split('\n')[1] : '(未命中)');
  console.log('孩子说:', USER);

  const baseline = await run(null);
  console.log('\n========== baseline 无护栏 ==========\n' + baseline);

  const treatment = await run(guardrail);
  console.log('\n========== treatment +KG 护栏 ==========\n' + treatment);

  const blacklist = ['先修', '知识图谱', '超纲', '节点'];
  const leaked = blacklist.filter((w) => treatment.includes(w));
  console.log('\n护栏黑话泄漏检查:', leaked.length ? '⚠️ 泄漏 ' + leaked.join(',') : '✅ 无黑话泄漏');
  process.exit(0);
}

main().catch((e) => {
  console.error('E2E 异常:', e?.message ?? e);
  process.exit(2);
});
