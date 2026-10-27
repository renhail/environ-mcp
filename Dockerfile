# ---------------------------------------------------------------------------
# environ-mcp —— MCP Server 容器镜像
#
# 构建：docker build -t environ-mcp:1.0.0 .
# 构建（Docker Hub 不通时走国内源）：
#   docker build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/node:22-alpine -t environ-mcp:1.0.0 .
# 运行：docker run -d -p 3000:3000 -e MCP_AUTH_TOKEN=xxx environ-mcp:1.0.0
# ---------------------------------------------------------------------------

# 基础镜像可覆盖：国内网络用 --build-arg BASE_IMAGE=<国内镜像源>/library/node:22-alpine
ARG BASE_IMAGE=node:22-alpine
# npm 源可覆盖（容器内直连 registry.npmjs.org 常常不通，默认走国内镜像）
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ---------- 构建阶段：装全量依赖（含 devDependencies，锁文件保证可复现） ----------
FROM ${BASE_IMAGE} AS builder

ARG NPM_REGISTRY
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm config set registry ${NPM_REGISTRY} \
    && npm ci --no-audit --no-fund

COPY src ./src

# ---------- 运行阶段：只带生产依赖 ----------
FROM ${BASE_IMAGE} AS runtime

ARG NPM_REGISTRY

# tini 负责转发信号并回收僵尸进程；wget 供 healthcheck 使用
RUN apk add --no-cache tini

WORKDIR /app

ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3000 \
    ENVIRON_TIMEOUT_MS=20000

COPY package.json package-lock.json ./
RUN npm config set registry ${NPM_REGISTRY} \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && chown -R node:node /app

COPY --from=builder --chown=node:node /app/src ./src

# 以非 root 运行
USER node

EXPOSE 3000

# 容器健康检查：compose 与编排平台都依赖它判断服务是否就绪
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/http-server.js"]
