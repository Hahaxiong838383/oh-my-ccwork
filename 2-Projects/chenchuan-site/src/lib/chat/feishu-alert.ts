import 'server-only'

export type AlertType =
  | 'budget_50'
  | 'budget_80'
  | 'budget_100'
  | 'burst_10min'
  | 'sustained_1h'
  | 'blacklist'
  | 'radar_degraded'

export interface ChatAlertPayload {
  type: AlertType
  title: string
  summary: string
  fields?: Record<string, string | number | boolean | null | undefined>
}

function getTemplate(type: AlertType): 'blue' | 'orange' | 'red' {
  if (type === 'budget_50') return 'blue'
  if (
    type === 'budget_80' ||
    type === 'burst_10min' ||
    type === 'sustained_1h' ||
    type === 'radar_degraded'
  )
    return 'orange'
  return 'red'
}

function toFieldMarkdown(fields: ChatAlertPayload['fields']): string {
  if (!fields) return ''
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `- **${key}**: ${String(value)}`)
  return lines.join('\n')
}

export async function sendChatAlert(payload: ChatAlertPayload): Promise<boolean> {
  const webhook = process.env.FEISHU_CHAT_ALERT_WEBHOOK
  if (!webhook) {
    return false
  }

  const fieldMarkdown = toFieldMarkdown(payload.fields)

  const body = {
    msg_type: 'interactive',
    card: {
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: getTemplate(payload.type),
        title: {
          tag: 'plain_text',
          content: payload.title,
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: payload.summary,
          },
        },
        ...(fieldMarkdown
          ? [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: fieldMarkdown,
                },
              },
            ]
          : []),
      ],
    },
  }

  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return resp.ok
  } catch {
    return false
  }
}
