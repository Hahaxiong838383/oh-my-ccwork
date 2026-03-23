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
  console.error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  process.exit(1);
}

const appToken = "X8XYbpcEDa1eWfs4lkscM0E6nPf";
const tableId = "tblgZ4up7nu6t3gC";

const rows = [
  ["张三", "001", "技术部", "前端工程师", "13800138000", "zhangsan@company.com"],
  ["李四", "002", "产品部", "产品经理", "13800138001", "lisi@company.com"],
  ["王五", "003", "设计部", "UI设计师", "13800138002", "wangwu@company.com"],
  ["赵六", "004", "技术部", "后端工程师", "13800138003", "zhaoliu@company.com"],
  ["钱七", "005", "市场部", "市场专员", "13800138004", "qianqi@company.com"],
  ["孙八", "006", "人事部", "HR专员", "13800138005", "sunba@company.com"],
  ["周九", "007", "财务部", "会计", "13800138006", "zhoujiu@company.com"],
  ["吴十", "008", "运营部", "运营专员", "13800138007", "wushi@company.com"],
  ["郑一", "009", "销售部", "销售经理", "13800138008", "zhengyi@company.com"],
  ["陈二", "010", "客服部", "客服专员", "13800138009", "chener@company.com"],
];

const client = new Lark.Client({
  appId,
  appSecret,
  domain: Lark.Domain.Feishu,
});

const payload = {
  path: {
    app_token: appToken,
    table_id: tableId,
  },
  data: {
    records: rows.map(([name, employeeNo, dept, title, phone, email]) => ({
      fields: {
        "姓名": name,
        "工号": employeeNo,
        "部门": dept,
        "职位": title,
        "手机": phone,
        "邮箱": email,
      },
    })),
  },
};

const resp = await client.bitable.appTableRecord.batchCreate(payload);
console.log(JSON.stringify(resp, null, 2));

if (resp.code !== 0) {
  process.exit(1);
}
