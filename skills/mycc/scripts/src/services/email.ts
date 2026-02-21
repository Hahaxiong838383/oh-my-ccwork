import nodemailer from 'nodemailer';

// Email configuration - using environment variables for security
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.163.com';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '25');
const EMAIL_USER = process.env.EMAIL_USER || '13911184569@163.com';
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || 'IPO Market Team <13911184569@163.com>';

// Create transporter
const transporter = nodemailer.createTransport({
  host: EMAIL_HOST,
  port: EMAIL_PORT,
  secure: false,
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Send an email
 */
export async function sendEmail(options: EmailOptions): Promise<boolean> {
  if (!EMAIL_PASS) {
    console.error('[Email] EMAIL_PASS not configured');
    return false;
  }

  try {
    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || options.html.replace(/<[^>]*>/g, ''),
    });

    console.log('[Email] Sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('[Email] Error:', error);
    return false;
  }
}

/**
 * Send IPO market report email
 */
export async function sendIPOReport(date: string, reportContent: string): Promise<boolean> {
  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; }
    .header p { margin: 10px 0 0; opacity: 0.9; }
    .content { background: #f9f9f9; padding: 30px; border-radius: 10px; margin-top: 20px; }
    .section { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .section h2 { color: #667eea; margin-top: 0; font-size: 20px; border-bottom: 2px solid #667eea; padding-bottom: 10px; }
    .section h3 { color: #764ba2; margin: 15px 0 10px; }
    .highlight { background: #fff8e1; padding: 15px; border-left: 4px solid #ffc107; margin: 15px 0; }
    .data-table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    .data-table th, .data-table td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    .data-table th { background: #667eea; color: white; }
    .data-table tr:hover { background: #f5f5f5; }
    .chart-placeholder { background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); height: 200px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #666; margin: 15px 0; }
    .footer { text-align: center; margin-top: 30px; padding: 20px; color: #666; font-size: 14px; }
    .tag { display: inline-block; background: #667eea; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; margin-right: 5px; }
    .tag.green { background: #10b981; }
    .tag.yellow { background: #f59e0b; }
    .tag.red { background: #ef4444; }
  </style>
</head>
<body>
  <div class="header">
    <h1>📊 IPO 市场每日调研报告</h1>
    <p>${date}</p>
  </div>

  <div class="content">
    ${reportContent}
  </div>

  <div class="footer">
    <p>本报告由 AI 自动生成，仅供参考</p>
    <p>如需订阅或退订，请联系管理员</p>
  </div>
</body>
</html>
  `;

  return sendEmail({
    to: '13911184569@163.com',
    subject: `📊 IPO 市场每日调研报告 - ${date}`,
    html: htmlContent,
  });
}

export default { sendEmail, sendIPOReport };
