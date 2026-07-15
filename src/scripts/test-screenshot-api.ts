import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 3000;

function httpPost(path: string, headers: Record<string, string>, body: Buffer | string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpDelete(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path, method: "DELETE" }, (res) => {
      res.on("data", () => {}); res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const createResp = await httpPost("/api/sessions", { "content-type": "application/json" }, JSON.stringify({
    appWhitelist: ["CRM"], durationHours: 24, retentionDays: 7, password: "demo-password-123456",
  }));
  const sid = JSON.parse(createResp.body).session.id;
  console.log("Created:", sid);

  await httpPost(`/api/sessions/${sid}/start`, { "content-type": "application/json" }, "{}");

  const pwd = "demo-password-123456";
  const r1 = await httpPost(`/api/sessions/${sid}/screenshot`, { "content-type": "application/json" }, JSON.stringify({
    password: pwd, appName: "CRM",
    precomputedText: "客户：张三  订单号：SO20250619001  邮箱 zhangsan@example.com",
  }));
  console.log("precomputedText:", JSON.parse(r1.body));

  const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const r2 = await httpPost(`/api/sessions/${sid}/screenshot`, { "content-type": "application/json" }, JSON.stringify({
    password: pwd, appName: "CRM", imageBase64: tinyPngBase64, summaryHint: "屏幕截图：客户列表页面",
  }));
  console.log("imageBase64:", JSON.parse(r2.body));

  const boundary = `----test${Date.now()}`;
  const lf = "\r\n";
  const png = Buffer.from(tinyPngBase64, "base64");
  const lines = [
    `--${boundary}`, `Content-Disposition: form-data; name="password"`, ``, pwd,
    `--${boundary}`, `Content-Disposition: form-data; name="appName"`, ``, `CRM`,
    `--${boundary}`, `Content-Disposition: form-data; name="summaryHint"`, ``, `屏幕截图：客户信息面板`,
    `--${boundary}`, `Content-Disposition: form-data; name="file"; filename="test.png"`, `Content-Type: image/png`, ``, ``,
  ].join(lf);
  const tail = `${lf}--${boundary}--${lf}`;
  const body = Buffer.concat([Buffer.from(lines, "utf8"), png, Buffer.from(tail, "utf8")]);
  const r3 = await httpPost(`/api/sessions/${sid}/screenshot`, { "content-type": `multipart/form-data; boundary=${boundary}` }, body);
  console.log("multipart:", JSON.parse(r3.body));

  const r4 = await httpPost(`/api/sessions/${sid}/screenshot`, { "content-type": "application/json" }, JSON.stringify({ password: "wrong", precomputedText: "hi" }));
  console.log("wrong password:", r4.status, r4.body);

  await httpDelete(`/api/sessions/${sid}`);
  console.log("done");
}

main().catch((e) => { console.error(e); process.exit(1); });
