#!/usr/bin/env node

/**
 * CLI script to send IPO report email
 * Usage: node scripts/send-report.js <report-html>
 */

import { sendIPOReport } from './src/services/email.js';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/send-report.js "<html-content>"');
  process.exit(1);
}

const reportHtml = args[0];
const date = new Date().toLocaleDateString('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
});

async function main() {
  console.log(`[Email] Sending IPO report for ${date}...`);
  const success = await sendIPOReport(date, reportHtml);

  if (success) {
    console.log('[Email] Report sent successfully!');
    process.exit(0);
  } else {
    console.error('[Email] Failed to send report');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[Email] Error:', error);
  process.exit(1);
});
