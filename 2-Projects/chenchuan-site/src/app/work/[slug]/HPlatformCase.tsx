import Link from 'next/link'
import styles from './HPlatformCase.module.css'

type FigureProps = {
  src: string
  alt: string
  caption: string
  width: number
  height: number
  eager?: boolean
}

function Figure({ src, alt, caption, width, height, eager }: FigureProps) {
  return (
    <figure className={styles.figure}>
      <a href={src} target="_blank" rel="noopener noreferrer" aria-label={'打开原图：' + alt}>
        <img src={src} alt={alt} width={width} height={height} loading={eager ? 'eager' : 'lazy'} decoding="async" />
      </a>
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

export function HPlatformCase() {
  return (
    <article className={styles.story}>
      <header className={styles.hero}>
        <div>
          <p className={styles.kicker}>独立软件项目 · 2026 至今</p>
          <h1>H 平台<span>团队 AI 工作助手</span></h1>
          <p className={styles.deck}>把每次写周报的偏好告诉助手，把好用的检查清单留给同事，把每天的晨报交给后台。工作仍在飞书里，反复交代和催进度的事可以少一些。</p>
          <p className={styles.byline}>陈川 · 产品设计与开发</p>
        </div>
        <Figure src="/h-platform-case/memory.webp" alt="H 平台「我的记忆」中打开一条周报偏好" caption="H 平台产品界面 · 演示数据。周报要先写什么，可以在「我的记忆」里看到，也可以直接改。" width={1160} height={720} eager />
      </header>

      <nav className={styles.contents} aria-label="项目导览">
        <a href="#shared-work">个人经验怎么复用</a>
        <a href="#background-work">任务怎么跑、结果怎么收</a>
        <a href="#team-handoff">跨部门怎么交接</a>
      </nav>

      <section id="shared-work" className={styles.chapter}>
        <div className={styles.copy}>
          <p className={styles.kicker}>在飞书里工作</p>
          <h2>上次交代过的事，<br />下次还能接着用。</h2>
          <p>同事把任务发给自己的飞书助手。开工前，助手会按当前问题查找相关记忆和知识，从允许使用的资料里挑出有用的部分。工作习惯变了，可以自己改。</p>
          <p>一套好用的工作方法也可以留给同事。比如部门共享一份交付检查清单，每个人都能复制一份，再按自己的工作改。</p>
        </div>
        <div className={styles.stack}>
          <Figure src="/h-platform-case/skills.webp" alt="H 平台技能列表区分个人、部门和全员共享的方法" caption="H 平台产品界面 · 演示数据。「交付检查」来自部门，「会议纪要」属于个人，在同一张表里能看清来源。" width={1160} height={565} />
          <Figure src="/h-platform-case/share.webp" alt="接收同事分享的清单时，界面提供接受与拒绝两项选择" caption="产品界面局部 · 演示数据。同事单独分享一份清单时，接收人先确认，再把它加进自己的助手。" width={1014} height={100} />
        </div>
      </section>

      <section id="background-work" className={styles.routing}>
        <p className={styles.kicker}>H 平台 · 后台执行与投递</p>
        <h2>明早要看的东西，今天交代好。</h2>
        <p className={styles.intro}>比如每天开工前，希望有人把“今天要我拍板的事”排在最前面。把这句话和时间存为定时任务，助手就能到点整理，发回飞书单聊。临时要跟进的事也可以只提醒一次。</p>
        <div className={styles.pair}>
          <div>
            <h3>把时间和交付要求一起存下来</h3>
            <Figure src="/h-platform-case/schedule.webp" alt="定时任务中配置每日晨间待办，并查看一次性提醒的投递状态" caption="产品界面 · 演示数据。上面能看到每天启用的晨间待办和已经送达的一次性提醒，下面可以修改时间与要求。" width={1014} height={469} />
          </div>
          <div>
            <h3>回答不合预期时，有地方查原因</h3>
            <Figure src="/h-platform-case/runtime.webp" alt="H 平台「它怎么工作」页展示个人规则、记忆检索、工具权限与执行环节" caption="产品界面 · 演示数据。从「记忆库」沿线看向「记忆检索」，可以查平台侧检索是否接通；再看「飞书权限」，能区分助手缺资料还是缺操作权限。" width={972} height={602} />
          </div>
        </div>

        <aside className={styles.note}>
          <p className={styles.kicker}>投递流程 · 据 H 平台代码整理</p>
          <h3>后台做完了，怎样确认结果发出去了？</h3>
          <ol className={styles.delivery}>
            <li><strong>后台执行</strong><span>耗时任务交给独立进程处理。</span></li>
            <li><strong>先存结果</strong><span>把生成的内容写入待发送队列。</span></li>
            <li><strong>发送到飞书</strong><span>发送失败，就保留结果，稍后重试。</span></li>
            <li><strong>记下发送回执</strong><span>拿到消息编号，才把这次投递记为成功。</span></li>
          </ol>
          <p>这样，遇到发送故障，可以从已保存的结果接着发。回执回答的是“飞书收到这条消息了吗”；至于成果能不能用，还需要负责人核对。</p>
        </aside>
      </section>

      <section id="team-handoff" className={styles.routing}>
        <p className={styles.kicker}>跨部门交接 · 关联项目 Jev 任务路由引擎</p>
        <h2>谁来负责，交什么算完成？</h2>
        <p className={styles.intro}>H 平台服务的是已经接到工作的同事。我做任务路由引擎，关注的是交办之前和交付之后：目标牵涉几个部门时，谁牵头，接手的人要知道什么，最后由谁判定做到了？</p>

        <h3 className={styles.subhead}>先定主责，让接单的人知道为什么找他</h3>
        <p className={styles.intro}>已有职责规则能定下主责，就按规则走；碰到职责交叉，Jev 再比较哪些部门更适合牵头、哪些适合协作。依据太少或候选接近，留给人决定。负责人能回看当时的依据，也能指出哪条职责需要修订。</p>
        <div className={styles.pair}>
          <Figure src="/task-router/desktop-hall.webp" alt="桌面协作厅设计稿中的部门工位与待办" caption="工作台设计稿 · 在同一间协作厅里看到部门和待办，先找到哪里需要人决定。" width={776} height={691} />
          <Figure src="/task-router/department-selection.webp" alt="路由引擎一级判定图，说明如何选择主责与协作部门" caption="职责判定流程图 · 顺着一次分工，看引擎依据什么给出主责和协作建议，以及哪里需要人工确认。" width={2000} height={1372} />
        </div>

        <h3 className={styles.subhead}>把验收条件和资料一起交出去</h3>
        <p className={styles.intro}>BRO 用来把交接写完整：事情因何而起、需求和谁确认过、目标与约束是什么。承接人读交接说明，他的助手拿到任务指令和获准使用的资料。之后按 PDCA 安排执行、检查成果、记录偏差，验收时仍然对照最初的目标。</p>
        <div className={styles.pair}>
          <Figure src="/task-router/role-package.webp" alt="角色任务包里的指令、上下文索引、资料和结果模板" caption="任务包结构图 · 同一份目标有两种读法。人看说明和背景，助手按任务指令找资料，再用约定的格式回交结果。" width={994} height={590} />
          <Figure src="/task-router/parent-acceptance.webp" alt="协作者返回成果，主责方汇总并验收原任务的流程" caption="验收流程图 · 各方交回成果，主责人对照派单时的要求核验，再决定原任务能否关闭。" width={940} height={590} />
        </div>
        <Figure src="/task-router/result-handoff.webp" alt="首版任务包导出、人工交接、结果回导的步骤" caption="首版交接流程图 · 任务包由人转交，执行结果再导回路由工作台。接手与交回各有一个清楚的动作。" width={940} height={303} />
        <Link className={styles.more} href="/work/task-router">看完整路由工作台、架构与交接流程 →</Link>
      </section>
      <details className={styles.details}>
        <summary>H 平台怎样实现个人隔离与后台执行</summary>
        <p>我用 Node.js 接入飞书，把消息接入和任务执行分开。每个人的凭据、工作目录和记忆分别管理，用 Bubblewrap 限制执行进程能访问的范围。ai-memory 结合全文和向量检索查找资料，SQLite 保存任务和待发送结果。H 平台已有真实多用户使用。</p>
      </details>
    </article>
  )
}
