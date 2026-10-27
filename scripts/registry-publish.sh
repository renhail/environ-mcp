#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# environ-mcp 上架官方 MCP Registry —— 一键脚本
#
# 做的事：
#   1. 生成 Ed25519 密钥对（私钥只落在本机 key.pem，不打印、不入库）
#   2. 算出公钥，打印出 DNS TXT 记录 / 环境变量的值
#   3. 选一种验证方式登录（dns 或 http）
#   4. 发布 server.json
#   5. 回读校验
#
# 用法：
#   ./scripts/registry-publish.sh              # 交互式（会问域名与验证方式）
#   ./scripts/registry-publish.sh --domain environ.online --mode dns
#
# 依赖：openssl、tools/mcp-publisher.exe（官方 Go 二进制，见下方「工具从哪来」）
# ---------------------------------------------------------------------------
set -euo pipefail

REGISTRY="https://registry.modelcontextprotocol.io"
DOMAIN=""
MODE=""          # dns | http
NAMESPACE=""     # 例如 com.environ.online/environ-mcp
KEY_FILE="$(dirname "$0")/../.registry-key.pem"
CLI="$(dirname "$0")/../tools/mcp-publisher.exe"

# 官方 CLI 是独立二进制，**没有官方 npm 包**：
#   npm i -g @modelcontextprotocol/registry-publisher  -> 404（不存在）
#   npm i -g mcp-publisher                            -> 是别人的包，别装
# 正确来源：https://github.com/modelcontextprotocol/registry/releases
#   下载 mcp-publisher_windows_amd64.tar.gz，解出 mcp-publisher.exe 放到 tools/
if [[ ! -x "$CLI" ]]; then
  echo "缺少官方发布工具：$CLI"
  echo ""
  echo "下载方式（GitHub 直连慢，建议走代理）："
  echo "  curl -L -o mp.tar.gz 'https://ghfast.top/https://github.com/modelcontextprotocol/registry/releases/download/v1.8.5/mcp-publisher_windows_amd64.tar.gz'"
  echo "  mkdir -p tools && tar -xzf mp.tar.gz -C tools"
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --mode)   MODE="$2";   shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."

if [[ -z "$DOMAIN" ]]; then
  read -r -p "你的域名（用于 com.<域名> 命名空间，例如 environ.online）: " DOMAIN
fi
if [[ -z "$MODE" ]]; then
  echo ""
  echo "选择域名所有权验证方式："
  echo "  dns   —— 在 DNS 加一条 TXT 记录（推荐，不用动 nginx）"
  echo "  http  —— 在 https://<域名>/.well-known/mcp-registry-auth 放公钥文件"
  read -r -p "方式 [dns]: " MODE
  MODE="${MODE:-dns}"
fi

echo ""
echo "==> 生成 Ed25519 密钥对"
if [[ -f "$KEY_FILE" ]]; then
  echo "    复用已有密钥：$KEY_FILE"
else
  openssl genpkey -algorithm Ed25519 -out "$KEY_FILE"
  echo "    已生成：$KEY_FILE（私钥，请勿提交到 git）"
fi
chmod 600 "$KEY_FILE"

PUBLIC_KEY="$(openssl pkey -in "$KEY_FILE" -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')"
PRIVATE_KEY="$(openssl pkey -in "$KEY_FILE" -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
PROOF="v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"

echo ""
echo "==> 你的公钥（这是公开信息，可以公开）："
echo ""
echo "    $PROOF"
echo ""

if [[ "$MODE" == "dns" ]]; then
  echo "==> 请到域名 DNS 里加一条 TXT 记录："
  echo ""
  echo "    主机记录: ${DOMAIN}"
  echo "    类型:     TXT"
  echo "    值:       ${PROOF}"
  echo ""
  echo "    加完等它生效（nslookup -type=TXT ${DOMAIN} 能查到即可），然后回车继续。"
  read -r -p "" _
else
  echo "==> 请把下面这一行放到：https://${DOMAIN}/.well-known/mcp-registry-auth"
  echo ""
  echo "    $PROOF"
  echo ""
  echo "    提示：environ-mcp 容器已经内置了这个端点（环境变量 MCP_REGISTRY_AUTH），"
  echo "          只需在启动容器时加上：-e MCP_REGISTRY_AUTH='${PROOF}'"
  echo "    或者用 nginx 直接返回："
  echo "      location = /.well-known/mcp-registry-auth {"
  echo "          default_type text/plain;"
  echo "          return 200 \"${PROOF}\\n\";"
  echo "      }"
  echo ""
  read -r -p "放好了就回车继续" _
fi

echo ""
echo "==> 登录 Registry（$MODE 验证）"
"$CLI" login "$MODE" --domain "$DOMAIN" --private-key "$PRIVATE_KEY" --registry="$REGISTRY"

echo ""
echo "==> 校验并发布 server.json"
"$CLI" validate server.json
"$CLI" publish server.json

if [[ -z "$NAMESPACE" ]]; then
  read -r -p "命名空间（回车用默认 com.${DOMAIN}/environ-mcp）: " NAMESPACE
  NAMESPACE="${NAMESPACE:-com.${DOMAIN}/environ-mcp}"
fi

echo ""
echo "==> 回读校验"
ENC="$(printf '%s' "$NAMESPACE" | sed 's|/|%2F|g')"
curl --fail --silent --show-error --max-time 60 \
  "https://registry.modelcontextprotocol.io/v0.1/servers?search=${ENC}" | head -c 800
echo ""
echo ""
echo "完成。已上架的元数据不可变 —— 以后改描述/配置要发新的版本号。"
