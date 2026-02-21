import nodemailer from "nodemailer";
import * as lark from "@larksuiteoapi/node-sdk";
import { PulseItem, PushResult } from "../types";

export class PusherService {
  private readonly maxRetries = 2;

  async push(channels: Array<"email" | "feishu">, items: PulseItem[]): Promise<PushResult[]> {
    const content = this.buildReport(items);
    const results: PushResult[] = [];

    for (const channel of channels) {
      if (channel === "email") {
        results.push(await this.pushEmail(content));
      }
      if (channel === "feishu") {
        results.push(await this.pushFeishu(content));
      }
    }

    return results;
  }

  private buildReport(items: PulseItem[]): string {
    const header = `每日科技热点 ${new Date().toLocaleDateString("zh-CN")}`;
    const lines = items.map((item, idx) => {
      const time = new Date(item.timestamp).toLocaleString("zh-CN");
      return `${idx + 1}. 【${item.category}】${item.title}\n${item.url}\n${item.summary}\n来源: ${item.source} | 时间: ${time} | 热度: ${item.hotScore}`;
    });
    return [header, "", ...lines].join("\n\n");
  }

  private async pushEmail(content: string): Promise<PushResult> {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT ?? "587");
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const to = process.env.EMAIL_TO;

    if (!host || !user || !pass || !to) {
      return { channel: "email", success: false, message: "Missing SMTP/EMAIL env config" };
    }

    return this.retryPush("email", async () => {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
      });

      await transporter.sendMail({
        from: process.env.EMAIL_FROM ?? user,
        to,
        subject: "每日科技热点",
        text: content
      });
    });
  }

  private async pushFeishu(content: string): Promise<PushResult> {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    const webhook = process.env.FEISHU_WEBHOOK;

    if (!webhook) {
      return { channel: "feishu", success: false, message: "Missing FEISHU_WEBHOOK" };
    }

    return this.retryPush("feishu", async () => {
      if (appId && appSecret) {
        const client = new lark.Client({ appId, appSecret });
        await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: process.env.FEISHU_CHAT_ID ?? "",
            msg_type: "text",
            content: JSON.stringify({ text: content })
          }
        });
      } else {
        const response = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msg_type: "text", content: { text: content } })
        });
        if (!response.ok) {
          throw new Error(`Webhook failed: ${response.status}`);
        }
      }
    });
  }

  private async retryPush(
    channel: "email" | "feishu",
    sender: () => Promise<void>
  ): Promise<PushResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        await sender();
        return { channel, success: true };
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
    }
    return { channel, success: false, message: String(lastError) };
  }
}
