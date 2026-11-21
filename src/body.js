'use strict';
// Reads an HTTP request body up to a limit. Past the limit the rest is read and
// discarded within a budget, so the client can still receive the 413.

const MiB = 1024 * 1024;
const DRAIN_BYTES = 4 * MiB;
const DRAIN_MS = 5000;

// Body limit for a given maximum text size.
function bodyLimit(maxTextBytes) {
  return 2 * maxTextBytes + MiB;
}

// Resolves once to { ok: true, body }, { ok: false, destroy }, or { ok: false, aborted: true }.
function readBody(req, { limit, drainBytes = DRAIN_BYTES, drainMs = DRAIN_MS }) {
  return new Promise(resolve => {
    const declared = req.headers['content-length'];
    if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > limit + drainBytes) {
      resolve({ ok: false, destroy: true });
      req.pause();
      return;
    }

    let kept = [];
    let total = 0;
    let over = false;
    let timer = null;
    let done = false;

    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('aborted', onAbort);
      resolve(result);
      if (result.destroy) req.pause();
    };

    const onData = chunk => {
      total += chunk.length;
      if (!over) {
        if (total <= limit) {
          kept.push(chunk);
          return;
        }
        // Over the limit: drop what was kept and drain within the budget.
        kept = [];
        over = true;
        timer = setTimeout(() => finish({ ok: false, destroy: true }), drainMs);
      }
      if (total - limit > drainBytes) finish({ ok: false, destroy: true });
    };

    const onEnd = () => {
      finish(over ? { ok: false, destroy: false } : { ok: true, body: Buffer.concat(kept) });
    };

    const onAbort = () => finish({ ok: false, aborted: true });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('aborted', onAbort);
  });
}

// Sends the rejection with Connection: close; optionally destroys the socket once it is written.
function sendTooLarge(req, res, status, headers, payload, destroy) {
  res.writeHead(status, { ...headers, 'Connection': 'close', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload, () => {
    if (destroy) req.socket.destroy();
  });
}

module.exports = { MiB, DRAIN_BYTES, DRAIN_MS, bodyLimit, readBody, sendTooLarge };
