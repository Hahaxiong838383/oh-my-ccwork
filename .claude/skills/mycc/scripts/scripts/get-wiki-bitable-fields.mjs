import fs from "node:fs";
import path from "node:path";
import Lark from "@larksuiteoapi/node-sdk";

const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, "utf8");
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error("Missing FEISHU_APP_ID / FEISHU_APP_SECRET");
  process.exit(1);
}

// Wiki embedded bitable
const appToken = "tblIOtkYt8lGs9RW";
const tableId = "tblIOtkYt8lGs9RW";

const client = new Lark.Client({
  appId,
  appSecret,
  domain: Lark.Domain.Feishu,
});

async function main() {
  // Get table fields using bitable.v1 API
  const fieldsResp = await client.bitabled.field.list({
    path: {
      app_token: appToken,
      table_id: tableId,
    },
  });
  console.log(JSON.stringify(fieldsResp, null, 2));

  if (fieldsResp.code !== 0) {
    console.error("Failed to get fields");
    process.exit(1);
  }

  const fields = fieldsResp.data?.items || [];
  console.log("Fields:", fields.map(f => ({ name: f.field_name, id: f.field_id, type: f.type })));
}

main().catch(console.error);
