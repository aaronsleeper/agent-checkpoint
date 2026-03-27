#!/usr/bin/env node

/**
 * Agent Checkpoint MCP Server (stdio transport)
 *
 * This is the untrusted side — it receives tool calls from agents and
 * forwards them to the VS Code extension via localhost HTTP.
 * All security decisions happen in the extension, not here.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import type { PortInfo, AskUserRequest, AskUserResponse } from './types.js';

const server = new McpServer({
  name: 'agent-checkpoint',
  version: '0.1.0',
});

// ─── Tool: ask_user ─────────────────────────────────────────────────────────

server.tool(
  'ask_user',
  'Ask the user a question via VS Code UI. Supports multiple-choice (bottom-right toast for ≤4 options, QuickPick for more) or free-text input. Questions are classified, rate-limited, and audited. Sensitive questions (credentials, keys, payments) will be blocked — instruct the user directly instead.',
  {
    question: z.string().describe('The question to ask the user'),
    options: z.array(z.object({
      id: z.string().describe('Unique identifier for this option'),
      label: z.string().describe('Display text for the option (keep short — shown as button)'),
      description: z.string().optional().describe('Additional context for the option'),
    })).max(6).describe('Options for the user to choose from (2-6). Required unless allowFreeText is true.'),
    allowFreeText: z.boolean().optional().describe('If true, show a text input instead of options. Blocked for sensitive questions. Response capped at 500 chars.'),
    freeTextPlaceholder: z.string().optional().describe('Placeholder text for the free-text input box'),
    agentId: z.string().optional().describe('Identifier for the calling agent/session'),
    toolChain: z.array(z.string()).optional().describe('Recent tools called before this question'),
  },
  async (params) => {
    const bridgeInfo = readPortFile();
    if (!bridgeInfo) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Agent Checkpoint extension is not running in VS Code. The user cannot see this question. Please communicate through the chat interface instead.',
        }],
        isError: true,
      };
    }

    const request: AskUserRequest = {
      questionId: crypto.randomUUID(),
      question: params.question,
      options: params.options,
      allowFreeText: params.allowFreeText,
      freeTextPlaceholder: params.freeTextPlaceholder,
      agentId: params.agentId,
      toolChain: params.toolChain,
      timestamp: Date.now(),
    };

    try {
      const response = await sendToExtension(bridgeInfo, request);

      if (response.blocked) {
        return {
          content: [{
            type: 'text' as const,
            text: `Question blocked by Agent Checkpoint: ${response.blockReason}. If this involves sensitive data, instruct the user to handle it directly through the chat interface.`,
          }],
          isError: true,
        };
      }

      if (response.selectedOptionId === 'rejected') {
        return {
          content: [{
            type: 'text' as const,
            text: 'The user dismissed this question. They may not want to answer right now, or the question may not be relevant. Consider proceeding with a default approach or asking in a different way.',
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `User selected: "${response.selectedLabel}" (id: ${response.selectedOptionId})`,
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Failed to reach Agent Checkpoint extension: ${err}. The user may need to restart VS Code or the extension.`,
        }],
        isError: true,
      };
    }
  },
);

// ─── Bridge Communication ───────────────────────────────────────────────────

function getPortFilePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return path.join(home, '.agent-checkpoint', 'bridge.json');
}

function readPortFile(): PortInfo | null {
  try {
    const data = fs.readFileSync(getPortFilePath(), 'utf-8');
    return JSON.parse(data) as PortInfo;
  } catch {
    return null;
  }
}

function sendToExtension(info: PortInfo, request: AskUserRequest): Promise<AskUserResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request);

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: info.port,
        path: '/ask',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Checkpoint-Token': info.token,
        },
        timeout: 120_000, // 2 minute timeout (user may take time to respond)
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve(data as AskUserResponse);
          } catch (err) {
            reject(new Error(`Invalid response from extension: ${err}`));
          }
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request to extension timed out'));
    });

    req.write(body);
    req.end();
  });
}

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Use stderr — stdout is reserved for JSON-RPC
  console.error('Agent Checkpoint MCP server running on stdio');
}

main().catch((err) => {
  console.error('Failed to start Agent Checkpoint server:', err);
  process.exit(1);
});
