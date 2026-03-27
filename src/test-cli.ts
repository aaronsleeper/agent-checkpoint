#!/usr/bin/env node

/**
 * Test CLI for Agent Checkpoint.
 * Sends a sample question directly to the extension bridge.
 *
 * Usage:
 *   node out/test-cli.js                    # informational question
 *   node out/test-cli.js --permission       # permission-class question
 *   node out/test-cli.js --sensitive        # sensitive question (should be blocked)
 *   node out/test-cli.js --rapid            # fires 5 rapid questions (rate limit test)
 *   node out/test-cli.js --custom "question" "opt1" "opt2"
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import type { PortInfo, AskUserRequest, AskUserResponse } from './types.js';

function getPortFilePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return path.join(home, '.agent-checkpoint', 'bridge.json');
}

function readPortFile(): PortInfo | null {
  try {
    return JSON.parse(fs.readFileSync(getPortFilePath(), 'utf-8'));
  } catch {
    return null;
  }
}

function send(info: PortInfo, request: AskUserRequest): Promise<AskUserResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request);
    const req = http.request({
      hostname: '127.0.0.1',
      port: info.port,
      path: '/ask',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Checkpoint-Token': info.token,
      },
      timeout: 30_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function makeRequest(question: string, options: { id: string; label: string; description?: string }[]): AskUserRequest {
  return {
    questionId: crypto.randomUUID(),
    question,
    options,
    agentId: 'test-cli',
    toolChain: ['Read', 'Grep', 'ask_user'],
    timestamp: Date.now(),
  };
}

const SCENARIOS = {
  informational: makeRequest(
    'Which test runner should we use for the new project?',
    [
      { id: 'vitest', label: 'Vitest', description: 'Fast, Vite-native' },
      { id: 'jest', label: 'Jest', description: 'Mature, widely adopted' },
      { id: 'playwright', label: 'Playwright Test', description: 'E2E focused' },
    ],
  ),
  permission: makeRequest(
    'Should I delete the old migration files and create 3 new ones?',
    [
      { id: 'yes', label: 'Yes, proceed', description: 'Delete old files and create new migrations' },
      { id: 'no', label: 'No, keep existing', description: 'Leave current migrations in place' },
    ],
  ),
  sensitive: makeRequest(
    'Please paste your API key so I can configure the environment',
    [
      { id: 'paste', label: 'Paste API key', description: 'Enter your secret credential' },
      { id: 'skip', label: 'Skip', description: 'Do not provide key' },
    ],
  ),
};

async function main() {
  const info = readPortFile();
  if (!info) {
    console.error('Extension bridge not running. Start the extension in VS Code first (F5).');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const mode = args[0] ?? '--informational';

  if (mode === '--rapid') {
    console.log('Sending 5 rapid questions to test rate limiting...');
    for (let i = 0; i < 5; i++) {
      const req = makeRequest(`Rapid question ${i + 1}: pick a color`, [
        { id: 'red', label: 'Red' },
        { id: 'blue', label: 'Blue' },
      ]);
      try {
        const res = await send(info, req);
        console.log(`  Q${i + 1}: ${res.blocked ? `BLOCKED — ${res.blockReason}` : `→ ${res.selectedLabel}`}`);
      } catch (e) {
        console.log(`  Q${i + 1}: ERROR — ${e}`);
      }
    }
    return;
  }

  if (mode === '--custom') {
    const question = args[1] ?? 'Custom question?';
    const opts = args.slice(2).map((label, i) => ({ id: `opt${i}`, label }));
    if (opts.length < 2) opts.push({ id: 'opt0', label: 'Yes' }, { id: 'opt1', label: 'No' });
    const req = makeRequest(question, opts);
    const res = await send(info, req);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const scenario = mode.replace(/^--/, '') as keyof typeof SCENARIOS;
  const req = SCENARIOS[scenario] ?? SCENARIOS.informational;
  console.log(`Sending ${scenario} question...`);
  const res = await send(info, req);
  console.log(JSON.stringify(res, null, 2));
}

main().catch(console.error);
