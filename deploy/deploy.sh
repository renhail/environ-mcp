#!/usr/bin/env bash
#
# environ-mcp 一键部署脚本（Linux 服务器，systemd 管理）
#
#   用法：sudo bash deploy.sh
#
# 幂等：重复执行会更新代码、重装依赖、重启服务。
# 不会自动改 nginx —— 反代片段需手工并入站点配置（见 deploy/nginx.conf.snippet）。
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/environ-mcp}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="environ-mcp"

echo "==> [1/6] 检查运行环境"
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 node，请先安装 Node.js 18+（推荐 22）" >&2
  exit 1
fi
echo "    node $(node -v) / npm $(npm -v)"

echo "==> [2/6] 同步代码到 ${APP_DIR}"
mkdir -p "${APP_DIR}"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude node_modules --exclude .git --exclude .env --exclude '*.log' \
    "${SRC_DIR}/src" "${SRC_DIR}/package.json" "${SRC_DIR}/package-lock.json" "${APP_DIR}/"
else
  rm -rf "${APP_DIR}/src"
  cp -r "${SRC_DIR}/src" "${APP_DIR}/"
  cp "${SRC_DIR}/package.json" "${SRC_DIR}/package-lock.json" "${APP_DIR}/"
fi

echo "==> [3/6] 安装依赖"
cd "${APP_DIR}"
npm ci --omit=dev --no-audit --no-fund

echo "==> [4/6] 准备环境变量文件"
if [ ! -f "${APP_DIR}/.env" ]; then
  AUTH_TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "${APP_DIR}/.env" <<EOF
# MCP 客户端访问令牌（WorkBuddy mcp.json 的 headers.Authorization 用这个）
MCP_AUTH_TOKEN=${AUTH_TOKEN}
# environ 后端地址（nginx /api 前缀会转发给 Spring Boot）
ENVIRON_API_BASE=https://app.environ.online/api
MCP_HOST=127.0.0.1
MCP_PORT=3000
ENVIRON_TIMEOUT_MS=20000
EOF
  chmod 600 "${APP_DIR}/.env"
  echo "    已生成 ${APP_DIR}/.env，访问令牌如下（请记下来）："
  echo "    ${AUTH_TOKEN}"
else
  echo "    ${APP_DIR}/.env 已存在，保留原配置"
fi

echo "==> [5/6] 安装并启动 systemd 服务"
cp "${SRC_DIR}/deploy/environ-mcp.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
systemctl restart "${SERVICE_NAME}"
sleep 2

echo "==> [6/6] 验证"
systemctl is-active "${SERVICE_NAME}" && echo "    服务状态：active"
echo "    健康检查："
curl -sS http://127.0.0.1:"$(grep -E '^MCP_PORT=' "${APP_DIR}/.env" | cut -d= -f2 || echo 3000)"/health
echo ""

cat <<EOF

────────────────────────────────────────────────────────────
部署完成。剩余两步需要手工操作：

1) nginx 反代（把下面的片段并入 app.environ.online 的 server 块）：
   ${SRC_DIR}/deploy/nginx.conf.snippet

   然后：
     nginx -t && systemctl reload nginx

2) WorkBuddy 客户端配置（~/.workbuddy/mcp.json）：
   {
     "mcpServers": {
       "environ-mcp": {
         "type": "http",
         "url": "https://app.environ.online/mcp",
         "headers": { "Authorization": "Bearer <上面打印的 MCP_AUTH_TOKEN>" }
       }
     }
   }

验证：node test/http-smoke.js https://app.environ.online/mcp
────────────────────────────────────────────────────────────
EOF
