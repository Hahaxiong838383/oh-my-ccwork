import styles from './XiaokeGallery.module.css'

const base = '/media/kidshub-20261126/'

type Plate = [file: string, title: string, width: number, height: number]

const scenes: Plate[] = [
  ['week.webp', '七天任务和奖励进度', 902, 312],
  ['garden.webp', '花园里的小可', 500, 314],
  ['music.webp', '换到音乐房间', 416, 258],
  ['autumn.webp', '秋日场景与装扮', 980, 652],
]

function Figure({ plate, caption }: { plate: Plate; caption?: string }) {
  const [file, title, width, height] = plate
  const src = file.startsWith('/') ? file : base + file
  return (
    <figure>
      <a href={src} target="_blank" rel="noopener noreferrer" aria-label={`查看大图：${title}`}>
        <img src={src} alt={title} width={width} height={height} loading="lazy" decoding="async" />
      </a>
      <figcaption>{caption ?? title}</figcaption>
    </figure>
  )
}

export function XiaokeGallery() {
  return (
    <article className={styles.story}>
      <header className={styles.hero}>
        <div>
          <p className={styles.line}>KidsHub AI · 青少年智能读写台</p>
          <h1>小可与成长世界</h1>
          <p>照片里，孩子们面前摆着爱视可空间光学读写台。小可就是这台读写设备里的 AI 语音伙伴。孩子可以直接和它说话，也可以在屏幕上照料自己的生态缸。我想知道，过些日子再开口，小可还能不能接上上次的话。</p>
          <a className={styles.official} href="https://www.eyescare-ai.com/" target="_blank" rel="noopener noreferrer">访问 EyesCare 爱视可产品官网 ↗</a>
        </div>
        <Figure plate={['/media/health-education/classroom-students.jpg', '孩子们在教室里使用读写台', 1280, 853]} caption="教室里的读写台 · 照片来自本站「K12 儿童智能硬件」项目" />
      </header>

      <nav aria-label="小可项目页目录">
        <a href="#device">读写台界面</a><a href="#reunion">隔了 22 天的对话</a><a href="#limits">小可记错的时候</a><a href="#mechanism">下一次怎样接话</a>
      </nav>

      <section id="device" className={styles.scenes}>
        <h2>在读写台上，怎么和小可相处？</h2>
        <p>说话时，小可和声波一起出现在屏幕上。轮到它思考、开口，表情和声波也随之变化。聊完回到主界面，还能看看今天的任务，接着上次的进度去养成。</p>
        <div className={styles.scenegrid}>
          <Figure plate={['eyescare-desk.webp', '爱视可空间光学读写台与桌面使用场景', 1090, 616]} caption="读写台展开后的样子。图片来自 EyesCare 爱视可产品官网。" />
          <Figure plate={['festival.webp', '感恩节活动主界面', 800, 480]} />
        </div>
        <div className={styles.scenegrid}>
          <Figure plate={['voice-listen.webp', '小可听你说话时的界面', 1086, 382]} />
          <Figure plate={['voice-response.webp', '从思考到开口回应', 1136, 388]} />
        </div>
        <details open>
          <summary>成长世界里的任务、房间和装扮</summary>
          <div className={styles.scenegrid}>{scenes.map(plate => <Figure key={plate[0]} plate={plate} />)}</div>
        </details>
      </section>

      <section id="reunion" className={styles.chapter}>
        <h2>隔了 22 天，小可又问起了黑洞</h2>
        <p>9 月 22 日，一台内测设备的记忆里留下了宇宙和黑洞。10 月 14 日，小可在回复里自己提起了这个旧话题，还问对方想不想接着聊。往前翻六小时，这台设备的对话里都没人再提黑洞。</p>
        <Figure plate={['reply.png', '10 月 14 日小可的回复', 760, 64]} caption="历史对话原图，截取小可的回复行。可以核对那天它怎么说；仅凭这一行，还无法判断是哪条记忆促成了这句话。" />
      </section>

      <section id="limits" className={styles.chapter}>
        <h2>提过一次，就算喜欢吗？</h2>
        <div className={styles.ledger}>
          <div>
            <h3>笔记比对方说得更肯定</h3>
            <p>11 月 23 日，对方提过想练舞，后台的兴趣栏随即多了一项。第二天的小笔记里出现了舞蹈，到 26 日已经写成“也爱跳舞”。写笔记时只取了兴趣名称，漏掉了“待确认”。这一句究竟能记到什么程度，得让对方以后自己确认。</p>
            <Figure plate={['interest.png', '11 月 23 日兴趣栏的更新记录', 728, 23]} caption="这行里的 interests+1 表示添了一条兴趣线索。" />
          </div>
          <div>
            <h3>语音切短了，小可也越说越少</h3>
            <p>另一台设备上，一句话被语音识别拆成好几个短句。系统以为对方爱简短回应，把小可的话语量一路调到 0.01。9 月 3 日的修复记录写明了切句的原因，数值回到 0.15。</p>
            <Figure plate={['repair.png', '话语量下调与修复的原始记录', 1155, 275]} caption="从下往上读，能看到连续几次下调，以及同一天稍晚的修复。" />
          </div>
        </div>
      </section>

      <section id="mechanism" className={styles.chapter}>
        <h2>下一次开口前，小可会翻哪些记录？</h2>
        <ol className={styles.steps}>
          <li><strong>先把眼前这句话接住</strong><p>读写台把声音传给服务端。语音转成文字后，系统按账号取回可用的记忆。回答一边生成，一边合成语音送回读写台。</p></li>
          <li><strong>聊完再记，过后再核</strong><p>聊天结束后，后台提取称呼、经历、兴趣和约定。每天再从近期原话里找依据，让小可把相处印象写成第一人称的小笔记。</p></li>
          <li><strong>下次挑合适的用</strong><p>回答前，小可可以读到笔记、有依据的观察，以及相似场景里接得好的一问一答。记下哪些材料被选中，日后就能核对。</p></li>
        </ol>
        <div className={styles.ledger}>
          <div><h3>小可怎样调整自己的说话方式</h3>
            <p>OpenHer 给了我一个思路：保留曾经接得好的一问一答。相似的接法反复奏效，可以多参考。久未用到，分量就逐渐降低。后台另有五项刻度，记的是小可自己的语气和风格。</p>
            <Figure plate={['traits.png', '小可说话时的五项倾向', 523, 239]} caption="这台设备选了“话痨小可”，图上同时列出了当天数值和这个档位的起点。" />
            <Figure plate={['change.png', '好奇引导的上调与回落', 794, 139]} caption="同一台设备的成长账本。互动后，“好奇引导”从 0.66 升到 0.68，次日回落到 0.67。对方实际听出了什么，还要回到当时的对话。" />
          </div>
          <div><h3>小可凭什么说自己了解对方</h3>
            <p>KnowMe 启发了另一项设计：每次归纳习惯，都要能找回支持它的原话。对话太少，或引文只勉强对得上，就降低把握。有充分依据的观察才拿给下一轮回答参考。</p>
            <Figure plate={['observation.png', '观察画像的样本、把握程度与天数', 158, 53]} caption="后台画像原图节选。这份观察用了七天内的 79 条发言，整体标为稳定；每项观察仍有各自的把握程度。" />
          </div>
        </div>
        <Figure plate={['prompt-traits.png', '回答前实际选入的说话倾向', 805, 20]} caption="另一台设备的后台原图，仅截取说话倾向这一行。这里能查到模型拿到了哪些数值；核对最终措辞要看回复，核对设备有没有播出要看播放回执。" />
        <Figure plate={['memory-design.webp', '语音、记忆和下一轮回答的技术流程图', 3440, 2196]} caption="点击放大。上半部是当场回答的路线，下半部是聊天结束后的学习；沿着回到顶部的箭头，可以找到下一轮取用记忆的位置。" />
        <p className={styles.source}>实录整理于 2026 年 11 月 26 日。18 个有真实对话的内测设备账号中，有 17 个留下了小笔记。查看时，10 台把观察画像放进了回答前的提示，13 台带上了过往的接话示例。设备可能共用，也包含成人对话。</p>
      </section>
      <section className={styles.end}>
        <h2>我负责的部分</h2>
        <p>我负责产品定义、交互取舍、借助 AI 实现软件，以及在真机上验证。硬件、供应链和量产由公司的跨职能团队共同推进。</p>
        <p>Android 管设备和语音，Godot 呈现角色与成长场景，Rust 保存进度和奖励。奖励先存下来，再播动画，中断后还能接着走。成长玩法已经过真机验证。</p>
        <p>小可与 MyJavis 共用一套实时语音引擎。对方可以中途插话，也可以把唤醒词和问题连着说。为了接住刚开口的半句话，设备先把声音暂存，连上后再按顺序补传。连着说的功能已单独验过，待合包发布。</p>
      </section>
    </article>
  )
}
