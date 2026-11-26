import type { Metadata } from 'next'
import { RouterFigure } from './RouterFigure'
import './task-router.css'

export const metadata: Metadata = {
  title: '任务路由引擎',
  description: '用 Jev 辅助判断任务归属，用 BRO-PDCA 对齐目标、交接背景、验收交付。',
}

export default function TaskRouterPage() {
  return (
    <article className="rr-article">
      <div className="rr-top"><a href="/work">作品</a> ／ 任务路由引擎</div>
      <h1>任务路由引擎</h1>
      <p className="rr-deck">从目标澄清、部门分工，到人和 Agent 都能接得住的任务交接。</p>
      <aside className="rr-focus">
        <small>设计起点</small>
        <h2>当每个人都有 AI 助手，任务交接就成了设计起点。</h2>
        <p>助手可以加快执行。组织仍需在任务提出时明确三件事：目标由谁负责，哪些背景和约束必须随任务传递，最终由谁对结果负责。</p>
        <p><strong>派出任务时就约定怎样衡量完成度、需要哪些证据、由谁验收。</strong>让分工和验收始终依据同一项目标。</p>
      </aside>
      <section id="jev">
        <small>分工决策</small>
        <h2>Jev 让任务归属有据可查</h2>
        <p>跨部门分工需要一个共同的判断依据。团队先确认任务目标和约束，再按组织已有的职责规则判定归属。规则尚不能明确主责时，Jev 只读取与分工有关的任务事实和职责依据，比较候选部门。判断依据不充分，或候选部门之间差异太小，就交由人裁决。</p>
        <p>对管理者而言，价值在于能看清一次推荐依据了什么、哪些职责仍有争议，以及何时需要人做决定。后续可以据此复核分工，修订职责规则。</p>
        <RouterFigure name="architecture" caption="总体架构 · 从任务输入、分配依据到部门承接" width={2000} height={1372} preview />
        <div className="rr-grid">
          <RouterFigure name="department-selection" caption="一级判定 · 看主责和协作部门如何选出" width={2000} height={1372} preview />
          <RouterFigure name="cross-team" caption="二级分工 · 看部门内拆分和跨部门协作怎样衔接" width={2000} height={1372} preview />
        </div>
      </section>
      <section id="bro-pdca">
        <small>目标管理与协作</small>
        <h2>BRO-PDCA 让目标在交接后仍能指导执行与验收</h2>
        <p>BRO 在派发前对齐背景与干系人、经沟通确认的需求，以及目标、原则和背后的原因。承接人收到可读的交接说明；他的 Agent 收到与角色对应的任务指令、知识索引和获准资料。两者对同一项目标负责，清楚哪些约束必须保留。</p>
        <p>PDCA 把这份共识带入计划、执行、检查和改进。主责方用派发时约定的标准验收交付物，将执行中发现的偏差留作复盘依据。涉及分工或交接规则的改动，经人工审核后再用于后续任务。</p>
        <div className="rr-note">
          <h3>两者如何配合</h3>
          <p>BRO 明确要达成什么，Jev 帮助判断由谁负责，PDCA 对照原目标验收成果。这样既能复核当初为何这样分工，也能根据交付证据判断下一次该改进哪里。</p>
        </div>
        <div className="rr-grid">
          <RouterFigure name="role-package" caption="任务包目录 · 指令、知识索引、资料和回执模板" width={994} height={590} preview />
          <RouterFigure name="result-handoff" caption="首版交接流程 · 文件导出、人工交接、结果回导" width={940} height={303} preview />
          <RouterFigure name="parent-acceptance" caption="验收流程 · 协作者交结果，主责方核验并关闭母任务" width={940} height={590} preview />
          <RouterFigure name="routing-feedback" caption="反馈流程 · 推荐、人工决定与后续规则修订" width={980} height={467} preview />
        </div>
      </section>
      <section>
        <h2>怎样衡量这套设计的价值？</h2>
        <p>设计评估关注三个问题：从目标确认到主责接单用了多久，多少任务因职责判断有误而改派，多少交付因遗漏背景或验收条件而需要返工。这些是评估口径，尚无公开实测结果。</p>
      </section>
      <section>
        <h2>工作台怎样把这些判断交还给人</h2>
        <p>0.5.8 的桌面设计用协作厅呈现部门与工位，窄屏则让当前待办进入视线。先看同场景的宽窄屏，再看问题展开后的状态。</p>
        <div className="rr-grid">
          <RouterFigure name="desktop-hall" caption="0.5.8 设计稿 · 桌面查看协作全貌" width={776} height={691} />
          <RouterFigure name="mobile-hall" caption="0.5.8 设计稿 · 同一协作厅的窄屏布局" width={358} height={524} />
          <RouterFigure name="mobile-queue-one" caption="0.5.8 设计稿 · 第一条问题待办" width={358} height={716} />
          <RouterFigure name="mobile-queue-two" caption="0.5.8 设计稿 · 第二条问题待办" width={358} height={716} />
        </div>
        <details open>
          <summary>展开其他工作室与早期原型（6 张）</summary>
          <div className="rr-grid">
            <RouterFigure name="garden-studio" caption="0.5.8 设计稿 · 弧窗绿植工作室" width={776} height={691} />
            <RouterFigure name="library-studio" caption="0.5.8 设计稿 · 整墙书架办公室" width={776} height={691} />
            <RouterFigure name="route-prototype" caption="早期设计原型 A · 用航线组织任务" width={1440} height={1208} preview />
            <RouterFigure name="town-prototype" caption="早期设计原型 B · 用场景组织部门" width={1440} height={1268} preview />
            <RouterFigure name="console-prototype" caption="早期设计原型 C · 信息集中展示" width={1440} height={1185} preview />
            <RouterFigure name="clarification-history" caption="历史版本 0.5.6 · 连续澄清选项" width={1440} height={1291} preview />
          </div>
        </details>
      </section><a href="/#work">← 返回首页精选项目</a>
    </article>
  )
}
