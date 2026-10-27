/**
 * 绑定页（GET /mcp/bind）
 *
 * 为什么单独做一页：让密码只在浏览器里输入，不经过聊天窗口、不落在对话记录中。
 * 页面与 MCP 服务同源，直接 fetch 绑定接口即可，不需要处理跨域。
 *
 * 密码处理：与 environ 前端登录页一致，**在浏览器里先做 MD5** 再提交，
 * 明文密码不离开浏览器（MCP 服务与后端都只拿到 MD5 值）。
 * 后端未升级（不支持 passwordMd5）时，按 passwordMode=auto 会自动回退一次明文。
 */
import { md5Hex } from "./md5.js";
import { config } from "./core.js";

export const bindPageHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>绑定 environ 账号到 environ-mcp</title>
<style>
  :root {
    --bg: #f6f6f4;
    --card: #ffffff;
    --text: #1f1f1e;
    --muted: #6b6a65;
    --line: rgba(0,0,0,.12);
    --accent: #185fa5;
    --accent-soft: #e6f1fb;
    --danger: #a32d2d;
    --danger-soft: #fcebeb;
    --ok: #3b6d11;
    --ok-soft: #eaf3de;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 16px; background: var(--bg); color: var(--text);
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex; justify-content: center;
  }
  .card {
    width: 100%; max-width: 460px; background: var(--card);
    border: 1px solid var(--line); border-radius: 12px; padding: 28px;
  }
  h1 { font-size: 18px; font-weight: 500; margin: 0 0 6px; }
  p.sub { margin: 0 0 22px; color: var(--muted); font-size: 13px; }
  label { display: block; font-size: 13px; margin: 14px 0 6px; }
  input {
    width: 100%; padding: 9px 11px; font-size: 14px; color: var(--text);
    background: #fff; border: 1px solid var(--line); border-radius: 8px; outline: none;
  }
  input:focus { border-color: var(--accent); }
  button {
    width: 100%; margin-top: 20px; padding: 10px 14px; font-size: 14px; font-weight: 500;
    color: #fff; background: var(--accent); border: none; border-radius: 8px; cursor: pointer;
  }
  button:disabled { opacity: .6; cursor: default; }
  .msg { margin-top: 16px; padding: 10px 12px; border-radius: 8px; font-size: 13px; display: none; }
  .msg.ok { display: block; background: var(--ok-soft); color: var(--ok); }
  .msg.err { display: block; background: var(--danger-soft); color: var(--danger); }
  .hint { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  .hint code { background: var(--accent-soft); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>绑定 environ 账号</h1>
    <p class="sub">绑定后，你的 WorkBuddy（小布）就用你本人的账号权限查站点数据。</p>

    <label for="key">客户端标识</label>
    <input id="key" placeholder="例如 3f7a1c9d2b4e5061a8c1d2e3f4a5b6c7" />
    <p class="hint" style="margin-top:8px;border:0;padding:0">
      在你的 <code>~/.workbuddy/mcp.json</code> 里配置的 <code>X-Environ-Client</code> 值，粘贴到这里。
    </p>

    <label for="user">environ 用户名</label>
    <input id="user" placeholder="手机号 / 邮箱 / 用户名" autocomplete="username" />

    <label for="pass">密码</label>
    <input id="pass" type="password" placeholder="environ 密码" autocomplete="current-password" />

    <button id="go">绑定</button>
    <div class="msg" id="msg"></div>

    <div class="hint">
      密码只在你的浏览器与服务器之间传输，不会进入聊天窗口。<br />
      绑定有效期 30 天；换账号或离职交接时，用同一个客户端标识重新绑定即可。
    </div>
  </div>

<script>
${md5Hex.toString()}

(function () {
  var keyEl = document.getElementById('key');
  var userEl = document.getElementById('user');
  var passEl = document.getElementById('pass');
  var goEl = document.getElementById('go');
  var msgEl = document.getElementById('msg');

  // auto   —— 先提交 MD5，失败后回退明文一次（兼容后端尚未支持 passwordMd5）
  // strict —— 只提交 MD5，绝不发送明文
  var MD5_MODE = '${config.passwordMode}';

  var fromQuery = new URLSearchParams(location.search).get('key');
  if (fromQuery) keyEl.value = fromQuery;

  function say(text, ok) {
    msgEl.textContent = text;
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
  }

  function post(payload) {
    return fetch(location.pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Environ-Client': keyEl.value.trim() },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }

  goEl.addEventListener('click', function () {
    var key = keyEl.value.trim();
    var user = userEl.value.trim();
    var pass = passEl.value;
    if (!key) return say('请填写客户端标识', false);
    if (!user || !pass) return say('请填写用户名和密码', false);

    goEl.disabled = true;
    say('正在绑定…', true);

    // 与 environ 前端登录页一致：密码在浏览器里先做 MD5，
    // 把 MD5 值放进 password 字段提交（后端会再 encrypt 一次去比对）。
    var md5 = md5Hex(pass);

    post({ username: user, password: md5 })
      .then(function (res) {
        if (res.body && res.body.ok) return res;
        if (MD5_MODE === 'strict') return res;
        // 回退：后端还是旧契约（收明文）时，用明文再试一次
        return post({ username: user, password: pass }).then(function (res2) {
          if (res2.body && res2.body.ok) return res2;
          return res;
        });
      })
      .then(function (res) {
        if (res.body && res.body.ok) {
          say('绑定成功：' + (res.body.userName || '') + '（ID ' + res.body.userId + '），有效期 ' + res.body.expireDays + ' 天。现在可以在 WorkBuddy 里直接问「XX 站点现在数据多少」了。', true);
        } else {
          say('绑定失败：' + ((res.body && res.body.error) || ('HTTP ' + res.status)), false);
        }
      })
      .catch(function (e) { say('请求失败：' + e.message, false); })
      .then(function () { goEl.disabled = false; });
  });
})();
</script>
</body>
</html>`;
