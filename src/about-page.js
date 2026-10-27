/**
 * 服务介绍页（GET /mcp/about）
 *
 * 用途：
 *   1. 作为 Registry 元数据里 websiteUrl 指向的页面（买家/目录站核对用）
 *   2. 同事第一次接入时的使用说明
 *
 * 原则：只放公开信息，**不出现任何令牌、内网地址、账号密码**。
 */
export const aboutPageHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>environ-mcp · 环境监测数据 MCP 服务</title>
<style>
  :root{
    --bg:#f6f6f4; --card:#fff; --text:#1f1f1e; --muted:#6b6a65;
    --line:rgba(0,0,0,.12); --accent:#185fa5; --accent-soft:#e6f1fb;
    --ok:#3b6d11; --ok-soft:#eaf3de; --code:#2b2b2a;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:40px 16px;background:var(--bg);color:var(--text);
    font:14px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{width:100%;max-width:820px;margin:0 auto}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;margin-bottom:16px}
  h1{font-size:20px;font-weight:600;margin:0 0 6px}
  h2{font-size:15px;font-weight:600;margin:26px 0 10px}
  p.sub{color:var(--muted);margin:0 0 4px}
  .tag{display:inline-block;font-size:12px;padding:2px 9px;border-radius:999px;
    background:var(--accent-soft);color:var(--accent);margin-right:6px}
  .tag.ok{background:var(--ok-soft);color:var(--ok)}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-weight:600;color:var(--muted);font-size:13px;white-space:nowrap}
  td code{background:var(--accent-soft);padding:1px 6px;border-radius:4px;font-size:12.5px}
  pre{background:var(--code);color:#f0efec;padding:14px 16px;border-radius:10px;overflow-x:auto;
    font:12.5px/1.65 ui-monospace,Menlo,Consolas,monospace}
  pre .k{color:#7cc4ff} pre .s{color:#b8e6a0} pre .c{color:#8a8a85}
  ol,ul{padding-left:22px;margin:8px 0}
  li{margin:5px 0}
  .note{background:var(--accent-soft);border-left:3px solid var(--accent);
    padding:10px 14px;border-radius:0 8px 8px 0;margin:12px 0;font-size:13px}
  .foot{color:var(--muted);font-size:12px;text-align:center;padding:8px 0 20px}
</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <h1>environ-mcp</h1>
    <p class="sub">环境监测站点数据查询 MCP 服务 · 让 AI 助手用自然语言查站点监测数据</p>
    <p style="margin:14px 0 0">
      <span class="tag ok">Streamable HTTP</span>
      <span class="tag ok">OAuth 2.1 + PKCE</span>
      <span class="tag">SSE 兼容</span>
      <span class="tag">多用户身份隔离</span>
    </p>
  </div>

  <div class="card">
    <h2>能做什么</h2>
    <table>
      <tr><th>工具</th><th>用途</th></tr>
      <tr><td><code>search_stations</code></td><td>按关键字搜站点（名称 / 编码 / 上级站点名 / 地址含城市区县）</td></tr>
      <tr><td><code>list_stations</code></td><td>列出当前账号有权限查看的全部站点</td></tr>
      <tr><td><code>get_realtime</code></td><td>查站点最新实时监测数据（各因子浓度值与单位）</td></tr>
      <tr><td><code>get_hour_data</code></td><td>查站点小时级数据序列（默认当天 0 点至今）</td></tr>
      <tr><td><code>get_overview</code></td><td>一次返回站点信息 + 实时数据 + 当日小时数据</td></tr>
      <tr><td><code>check_bind</code></td><td>查看当前身份来源、绑定是否有效、可见站点数</td></tr>
      <tr><td><code>bind_user</code></td><td>用账号密码完成绑定（密码在客户端侧哈希后再提交）</td></tr>
      <tr><td><code>unbind_user</code></td><td>解除绑定（需 <code>confirm=true</code>）</td></tr>
      <tr><td><code>get_client_config</code></td><td>生成可直接粘贴的 MCP 接入配置片段</td></tr>
    </table>
  </div>

  <div class="card">
    <h2>三步接入</h2>
    <ol>
      <li><b>配置客户端</b> —— 在 MCP 客户端配置里加一段（下面有示例）</li>
      <li><b>绑定账号</b> —— 浏览器打开绑定页，填入你的客户端标识与账号密码</li>
      <li><b>开始提问</b> —— 直接用自然语言问，比如「我有哪些站点」「XX 站现在数据多少」</li>
    </ol>

    <h2>客户端配置示例</h2>
    <pre><span class="c">// mcp.json（WorkBuddy / CodeBuddy / Claude Desktop 等通用格式）</span>
{
  <span class="k">"mcpServers"</span>: {
    <span class="k">"environ-mcp"</span>: {
      <span class="k">"type"</span>: <span class="s">"streamableHttp"</span>,
      <span class="k">"url"</span>: <span class="s">"https://app.environ.online/mcp"</span>,
      <span class="k">"headers"</span>: {
        <span class="k">"Authorization"</span>: <span class="s">"Bearer &lt;你的 MCP 访问令牌&gt;"</span>,
        <span class="k">"X-Environ-Client"</span>: <span class="s">"&lt;你自己的 32 位随机串&gt;"</span>
      },
      <span class="k">"timeout"</span>: <span class="s">60000</span>
    }
  }
}</pre>
    <div class="note">
      <b>X-Environ-Client</b> 是你的<b>个人标识</b>，每人一个、互不相同（用
      <code>openssl rand -hex 16</code> 生成）。它决定服务端把哪个账号的权限给你，
      所以每个人绑定时都要填自己的那个值。
    </div>

    <h2>绑定页</h2>
    <p>打开 <code>https://app.environ.online/mcp/bind</code>，填写上面的客户端标识与
      environ 账号密码即可。密码在<b>浏览器里</b>就完成了哈希，明文不会出现在网络请求的
      凭据字段中，也不会进入聊天记录。</p>
  </div>

  <div class="card">
    <h2>使用示例</h2>
    <ul>
      <li>「我有哪些站点」</li>
      <li>「有哪些污水站」 / 「重庆有哪些监测点」</li>
      <li>「1#监测点（乙酰厂）现在 SO₂ 多少」</li>
      <li>「新兴纺织一楼今天各小时的数据」</li>
      <li>「XX 站今天情况怎么样」（最省事，等于总览）</li>
    </ul>
  </div>

  <div class="card">
    <h2>关于数据</h2>
    <p>数据来自企业内部环境监测业务系统，用于运维巡检与监管速查。
      <b>每位使用者需用自己的账号绑定</b>，只能看到自己权限范围内的站点，互不影响。
      部分站点的实时数据取决于现场设备上报状态，可能暂时为空。</p>
  </div>

  <div class="foot">environ-mcp · MCP Registry: online.environ/environ-mcp</div>
</div>
</body>
</html>`;
