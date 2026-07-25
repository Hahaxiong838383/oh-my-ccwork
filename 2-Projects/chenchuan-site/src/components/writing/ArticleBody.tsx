import { Fragment } from 'react'

/**
 * 文章正文轻量渲染：支持 #### 小标题、空行分段、**加粗**。
 * 不引入 markdown 依赖——writing 文章只用到这三种语法。
 */

function renderInline(text: string, keyPrefix: string) {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={`${keyPrefix}-${i}`} className="font-semibold text-text-primary">
        {part}
      </strong>
    ) : (
      <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>
    ),
  )
}

export function ArticleBody({ content }: { content: string }) {
  const blocks = content
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)

  return (
    <div className="space-y-6">
      {blocks.map((block, i) => {
        const heading = block.match(/^#{2,6}\s+(.+)$/)
        if (heading) {
          return (
            <h2 key={i} className="mt-10 text-xl font-semibold tracking-tight text-text-primary">
              {renderInline(heading[1], `h-${i}`)}
            </h2>
          )
        }
        return (
          <p key={i} className="leading-relaxed text-text-secondary">
            {renderInline(block, `p-${i}`)}
          </p>
        )
      })}
    </div>
  )
}
