const fs = require("fs");
const http = require("http");

function loadEnv() {
  const env = {};
  for (const line of fs
    .readFileSync("C:/Ai/Luoxia-Deployment/.env.local", "utf8")
    .split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i)] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: d }),
        );
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const env = loadEnv();
  const port = env.LUOXIA_PROVISION_PORT || "8010";
  const secret = env.LUOXIA_PROVISION_SECRET;
  const locale = env.LUOXIA_PROVISION_PLAYER_LOCALE || "zh-CN";
  const player = env.LUOXIA_PROVISION_PLAYER_NAME || "试玩者";
  console.log("POST provision", port, "player", player);
  const r = await postJson(
    `http://127.0.0.1:${port}/provision/new-play`,
    { "x-luoxia-provision-secret": secret },
    { player_name: player, locale },
  );
  console.log("status", r.status);
  console.log(r.body.slice(0, 2000));

  // Latest failure row
  const { Client } = require("pg");
  const client = new Client({ connectionString: env.LUOXIA_DATABASE_URL });
  await client.connect();
  const rows = await client.query(`
    select request_id, failure_output_summary, failed_at, prepared_at
    from luoxia_engine.model_invocations
    where failure_code = 'model.provider.output_not_json'
    order by failed_at desc nulls last
    limit 1
  `);
  console.log("latest fail", JSON.stringify(rows.rows[0], null, 2));
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
