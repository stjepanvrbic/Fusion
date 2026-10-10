#!/usr/bin/env node
// Schema-only MCP server. Reads tool schemas from a JSON file and executes nothing.
//
// FNXC:ClaudeCliToolOwnership 2026-10-10-20:56:
// Fusion is the only executor of its tools. The Claude CLI calls this server the moment the model asks for a tool, so the call is acknowledged with a notice that the host runs it.
// The acknowledgement gives the CLI's transcript a result for every tool call. A call left unanswered is recorded on resume as "interrupted, outcome unknown", which contradicts the real result Fusion reports in the next message.
"use strict";

const fs = require("fs");
const readline = require("readline");

const HOST_EXECUTION_NOTICE =
  "Result pending: the host application runs this tool and reports its result in the next message. This notice is not the tool's result.";

/** The JSON-RPC response to one request, or undefined for notifications and unknown methods. */
function respond(msg, tools) {
  if (msg.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "custom-tools", version: "1.0.0" },
      },
    };
  }
  if (msg.method === "tools/list") {
    return { jsonrpc: "2.0", id: msg.id, result: { tools } };
  }
  if (msg.method === "tools/call") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: HOST_EXECUTION_NOTICE }] },
    };
  }
  return undefined;
}

function serve(schemaPath) {
  let tools = [];
  try {
    tools = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  } catch {
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const resp = respond(msg, tools);
    if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
  });
}

if (require.main === module) {
  if (!process.argv[2]) process.exit(1);
  serve(process.argv[2]);
}

module.exports = { respond, HOST_EXECUTION_NOTICE };
