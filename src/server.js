#!/usr/bin/env node
/**
 * environ 环境监测数据 MCP Server —— stdio 入口（本地模式）
 *
 * 供 WorkBuddy 本地拉起。HTTP 入口见 http-server.js。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { config, log, VERSION } from "./core.js";

const server = new McpServer({ name: "environ-mcp", version: VERSION });
registerTools(server, { mode: "stdio" });

const transport = new StdioServerTransport();
await server.connect(transport);
log(`已启动(stdio)。后端地址=${config.apiBase}`);
