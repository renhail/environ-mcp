#!/usr/bin/env node
/**
 * 命令行绑定工具 —— 把 environ 账号绑定到自己的客户端标识上。
 *
 * 为什么单独一个脚本：密码只在本机终端输入，不经过聊天窗口、不落在对话记录里。
 *
 * 用法：
 *   node scripts/bind.js --url https://app.environ.online/mcp/bind \
 *                        --key <你的客户端随机串> --user <environ 用户名>
 *
 * 可选参数：
 *   --token   MCP 访问令牌（默认读环境变量 MCP_AUTH_TOKEN）
 *   --password 密码（默认交互式输入，不回显；也可用环境变量 ENVIRON_PASSWORD）
 *
 * 客户端随机串生成：openssl rand -hex 16
 */

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/** 终端隐藏输入（raw mode，不回显） */
function hiddenPrompt(question) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    return Promise.resolve("");
  }
  stdout.write(question);
  const wasRaw = stdin.isRaw;
  if (stdin.setRawMode) stdin.setRawMode(true);
  return new Promise((resolve) => {
    let buf = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

const args = parseArgs(process.argv);
const url = args.url || process.env.ENVIRON_BIND_URL;
const clientKey = args.key || process.env.ENVIRON_CLIENT_KEY;
const user = args.user || process.env.ENVIRON_USER;
const token = args.token || process.env.MCP_AUTH_TOKEN;

if (!url || !clientKey || !user) {
  console.error(
    "用法：node scripts/bind.js --url <绑定地址> --key <客户端随机串> --user <用户名>\n" +
      "  例：node scripts/bind.js --url https://app.environ.online/mcp/bind \\\n" +
      "      --key 3f7a1c9d2b4e5061 --user 18785035798"
  );
  process.exit(1);
}

const password = args.password || process.env.ENVIRON_PASSWORD || (await hiddenPrompt("请输入 environ 密码："));
if (!password) {
  console.error("未提供密码，已取消。");
  process.exit(1);
}

const headers = { "Content-Type": "application/json" };
if (token) headers.Authorization = `Bearer ${token}`;
headers["X-Environ-Client"] = clientKey;

try {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: user, password }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`绑定失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    process.exit(1);
  }
  if (!res.ok || json.error) {
    console.error(`绑定失败：${json.error || `HTTP ${res.status}`}`);
    process.exit(1);
  }
  console.log(`绑定成功。`);
  console.log(`  用户：${json.userName}（ID ${json.userId}）`);
  console.log(`  有效期：${json.expireDays} 天`);
  console.log(`  客户端标识：${String(clientKey).slice(0, 8)}…`);
  console.log("");
  console.log("接下来把同样的客户端标识写进 ~/.workbuddy/mcp.json 的 headers：");
  console.log(`  "X-Environ-Client": "${clientKey}"`);
  console.log("然后重启 WorkBuddy 会话即可。");
} catch (ex) {
  console.error(`绑定失败：${ex.message}`);
  process.exit(1);
}
