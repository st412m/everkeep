'use strict';
/**
 * Everkeep over stdio: newline-delimited JSON-RPC on stdin and stdout, the same
 * dispatcher as HTTP. stdout carries the protocol and nothing else; every other
 * line goes to stderr. No token: the client starts the process.
 *
 * Requests are answered as they finish, so a slow tool call does not hold up a
 * ping. A batch (a JSON array) is answered with one array, as over HTTP.
 */

const readline = require('readline');
const S = require('./server');

function serveStdio({ input = process.stdin, output = process.stdout, dispatch = S.handleMcpRequest } = {}) {
  const send = msg => output.write(JSON.stringify(msg) + '\n');
  const pending = new Set();

  async function handleLine(line) {
    if (!line.trim()) return;
    let body;
    try { body = JSON.parse(line); }
    catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const requests = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const r of requests) {
      const resp = await dispatch(r);
      if (resp !== null) responses.push(resp);
    }
    const result = Array.isArray(body) ? responses : (responses[0] || null);
    if (result !== null && !(Array.isArray(result) && !result.length)) send(result);
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', line => {
    const p = handleLine(line).catch(e => {
      process.stderr.write(`everkeep: stdio request failed: ${e && e.stack || e}\n`);
      send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    });
    pending.add(p);
    p.finally(() => pending.delete(p));
  });

  // Resolves when stdin ends and every answer has been written.
  const closed = new Promise(resolve => rl.on('close', () => Promise.allSettled([...pending]).then(() => resolve())));
  return { closed };
}

module.exports = { serveStdio };
