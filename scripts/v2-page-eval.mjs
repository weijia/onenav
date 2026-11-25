import fs from 'node:fs';

const jsonPath = process.env.CDP_JSON || process.env.TEMP + '/cdp-tabs.json';
const match = process.env.CDP_MATCH || 'v2-test.html';
const tabs = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const tab = tabs.find((item) => item.type === 'page' && item.url.includes(match));
if (!tab) throw new Error(`page not found: ${match}`);
const expression = process.argv.slice(2).join(' ') || '1';
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  return new Promise((resolve) => {
    const callId = ++id;
    pending.set(callId, resolve);
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
}
ws.onopen = async () => {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const result = response.result;
  if (result.exceptionDetails) {
    console.error(JSON.stringify(result.exceptionDetails, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result.result ? result.result.value : result, null, 2));
  }
  ws.close();
};
