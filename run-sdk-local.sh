#!/bin/bash
# 本地起一个实例（根路径 .well-known 可达），用官方 SDK 客户端验证完整 OAuth 流程
PORT=3114
export MCP_AUTH_TOKEN=local-probe-token
export MCP_PORT=$PORT
export MCP_HOST=127.0.0.1
export ENVIRON_API_BASE=${ENVIRON_API_BASE:-http://localhost:8081}
export ENVIRON_BINDINGS_FILE=/tmp/local-bindings.json
export ENVIRON_OAUTH_FILE=/tmp/local-oauth.json
export MCP_PUBLIC_URL=http://127.0.0.1:$PORT/mcp
node src/http-server.js & SRV=$!
sleep 3
node test/oauth-sdk-client.js http://127.0.0.1:$PORT/mcp
RC=$?
kill $SRV 2>/dev/null
exit $RC
