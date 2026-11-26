const base = '/media/kidshub-20261126/'

type Plate = [file: string, title: string, width: number, height: number]

const scenes: Plate[] = [
  ['festival.webp', '感恩节活动主界面', 800, 480],
  ['voice-listen.webp', '听对方说话', 1086, 382],
  ['voice-response.webp', '思考与回应', 1136, 388],
  ['week.webp', '七天任务与奖励进度', 902, 312],
  ['garden.webp', '成长场景 · 花园', 500, 314],
  ['music.webp', '成长场景 · 音乐房间', 416, 258],
  ['autumn.webp', '秋日场景与装扮', 980, 652],
]

const evidence: { plate: Plate; caption: string }[] = [
  { plate: ['reply.png', '隔了 22 天，小可又问起了黑洞', 760, 64], caption: '实录记载，9 月 22 日这台设备存下宇宙和黑洞的话题。图中是 10 月 14 日小可的回复行。它再次提到了黑洞，日志尚不能把这句话归因于某一条记忆。' },
  { plate: ['interest.png', '一句话让兴趣栏多了一项', 728, 23], caption: '11 月 23 日，一次练舞意愿触发了兴趣更新。截取账本的结果行，可以看到 interests+1。要判断这是不是长期爱好，还需要后续确认。' },
  { plate: ['traits.png', '小可用怎样的语气接话', 523, 239], caption: '五项刻度描述小可自身的说话风格。这台设备选择了“话痨小可”，图中可对照当前数值和所选风格的基线。' },
  { plate: ['change.png', '一次互动之后，数值怎样变化', 794, 139], caption: '从下往上读。11 月 25 日，互动触发“好奇引导”从 0.66 升到 0.68；次日自然回落到 0.67。账本可以追溯变化，听起来有什么差别还要回到实际对话。' },
  { plate: ['repair.png', '系统也留下误判和修正', 1155, 275], caption: '语音识别把话切成几个短句，系统据此调低了小可的话语量。9 月 3 日的修复行保留了原因和从 0.01 回到 0.15 的记录。' },
]

function Original({ plate }: { plate: Plate }) {
  const [file, title, width, height] = plate
  return (
    <a href={base + file} target="_blank" rel="noopener noreferrer" aria-label={`查看大图：${title}`} className="block rounded-lg focus-visible:outline-accent">
      <img src={base + file} alt={title} width={width} height={height} loading="lazy" decoding="async" className="mx-auto block h-auto max-w-full rounded-lg" />
    </a>
  )
}

export function XiaokeGallery() {
  return (
    <div className="mx-auto mb-12 max-w-4xl">
      <section aria-labelledby="xiaoke-scenes">
        <h2 id="xiaoke-scenes" className="mb-2 text-2xl font-semibold">读写台上的小可</h2>
        <p className="mb-5 text-sm leading-relaxed text-text-secondary">从听你说话、开口回应，到每天打开的任务和成长世界。点图可以查看界面细节。</p>
        <figure className="rounded-xl border border-border bg-bg-card p-3">
          <Original plate={scenes[0]} />
          <figcaption className="mt-2 text-center text-sm text-text-secondary">{scenes[0][1]}</figcaption>
        </figure>
        <details className="mt-3 rounded-xl border border-border p-4">
          <summary className="cursor-pointer text-sm text-accent">查看其余六张界面图</summary>
          <div className="mt-4 grid gap-5 md:grid-cols-2">
            {scenes.slice(1).map((plate) => <figure key={plate[0]}><Original plate={plate} /><figcaption className="mt-2 text-sm text-text-secondary">{plate[1]}</figcaption></figure>)}
          </div>
        </details>
      </section>
      <section aria-labelledby="xiaoke-records" className="mt-10">
        <h2 id="xiaoke-records" className="mb-2 text-2xl font-semibold">小可记住了什么？</h2>
        <p className="mb-6 text-sm leading-relaxed text-text-secondary">这些后台截图选自 2026 年 11 月 26 日整理的 18 台内测设备实录，其中包含共用设备和成人对话。下面只展示与每个判断有关的记录。</p>
        {evidence.map(({ plate, caption }) => (
          <figure key={plate[0]} className="mb-5 rounded-xl border border-border bg-bg-card p-4 md:p-6">
            <h3 className="mb-2 text-lg font-semibold">{plate[1]}</h3>
            <figcaption className="mb-4 text-sm leading-relaxed text-text-secondary">{caption}</figcaption>
            <div className="rounded-lg bg-white p-2"><Original plate={plate} /></div>
          </figure>
        ))}
      </section>
    </div>
  )
}
