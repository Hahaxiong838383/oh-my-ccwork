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
          <p className={styles.deck}>同事在飞书里交办一件事，助手怎样带着背景开工？事情跨了部门，又该由谁接下来？</p>
          <p className={styles.byline}>陈川 · 产品设计与开发</p>
        </div>
        <Figure src="/h-platform-case/memory.webp" alt="H 平台「我的记忆」中打开一条周报偏好" caption="H 平台产品界面 · 演示数据。周报要先写什么，可以在「我的记忆」里看到，也可以直接改。" width={1160} height={720} eager />
      </header>

      <section className={styles.chapter}>
        <div className={styles.copy}>
          <p className={styles.kicker}>在飞书里工作</p>
          <h2>上次交代过的事，<br />下次还能接着用。</h2>
          <p>同事把任务发给自己的飞书助手。开工前，助手会按当前问题查找相关记忆和知识，从允许使用的资料里挑出有用的部分。工作习惯变了，可以自己改。</p>
          <p>一套好用的工作方法也可以留给同事。比如部门共享一份交付检查清单，每个人都能复制一份，再按自己的工作改。</p>
        </div>
        <Figure src="/h-platform-case/skills.webp" alt="H 平台技能列表区分个人、部门和全员共享的方法" caption="H 平台产品界面 · 演示数据。「交付检查」来自部门，「会议纪要」属于个人，在同一张表里能看清来源。" width={1160} height={565} />
      </section>

      <aside className={styles.note}>
        <h3>做完以后，结果送到了吗？</h3>
        <p>耗时任务交给后台执行。助手先保存结果，再发回飞书；发送失败，结果还留在待发送队列里，可以重试。飞书的发送回执用来确认投递，交付物是否合格仍由负责人判断。</p>
      </aside>

      <section className={styles.routing}>
        <p className={styles.kicker}>跨部门交接 · 关联项目 Jev 任务路由引擎</p>
        <h2>谁来负责，交什么算完成？</h2>
        <p className={styles.intro}>做 H 平台时，我关注的是一个同事怎样把事交给自己的助手。在任务路由引擎里，我把问题往前挪了一步：收到一个团队目标时，先定主责，再把背景和验收标准一起交出去。</p>
        <div className={styles.pair}>
          <div>
            <Figure src="/task-router/desktop-hall.webp" alt="任务路由引擎的桌面协作厅设计稿" caption="工作台设计稿 · 把部门和待办放在同一个协作厅里，方便人查看并作决定。" width={776} height={691} />
            <h3>Jev 帮人判断，哪个部门该接单</h3>
            <p>职责规则能确定主责时，直接按规则分工。遇到职责交叉，Jev 再比较候选部门与任务目标的匹配程度，区分主责和协作。依据薄弱或候选接近时，交给人拍板。</p>
          </div>
          <div>
            <Figure src="/task-router/role-package.webp" alt="角色任务包中的任务指令、上下文索引、资料和回执模板" caption="任务包结构图 · 人能读交接说明，接手人的助手也能拿到指令、资料索引和回执模板。" width={994} height={590} />
            <h3>BRO-PDCA 让交接和验收对得上</h3>
            <p>派单前用 BRO 说清事情的来由、确认过的需求、目标与约束，再约定交什么、谁验收。接手后用 PDCA 安排执行、核对结果、记录偏差。首版通过导出任务包、人工交接、回导结果完成这一步。</p>
          </div>
        </div>
        <Link className={styles.more} href="/work/task-router">看完整路由工作台、架构与交接流程 →</Link>
      </section>
      <details className={styles.details}>
        <summary>H 平台怎样实现个人隔离与后台执行</summary>
        <p>我用 Node.js 接入飞书，把消息接入和任务执行分开。每个人的凭据、工作目录和记忆分别管理，用 Bubblewrap 限制执行进程能访问的范围。ai-memory 结合全文和向量检索查找资料，SQLite 保存任务和待发送结果。H 平台已有真实多用户使用。</p>
      </details>
    </article>
  )
}
