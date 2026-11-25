import fs from 'node:fs';

const tabs = JSON.parse(fs.readFileSync(process.env.TEMP + '/cdp-golf-tabs.json', 'utf8'));
const tab = tabs.find((item) => item.type === 'page' && item.url.includes('/apps/golf/index.html'));
if (!tab) throw new Error('golf page not found');
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
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const result = response.result;
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
  return result.result ? result.result.value : undefined;
}

ws.onopen = async () => {
  try {
    await send('Runtime.enable');
    await evaluate(`(async () => {
      if (typeof window.ZenFSConfigUI?.connectV2 !== 'function') {
        const script = document.createElement('script');
        script.src = '/v2/zen-fs-config-ui.js';
        document.head.appendChild(script);
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
        });
      }
      if (typeof window.ZenFSConfigUI?.connectV2 !== 'function') {
        throw new Error('V2 bundle not available');
      }
      return true;
    })()`);

    const result = await evaluate(`(async () => {
      const checks = [];
      const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail ?? '' });
      const APP_ID = 'v2-golf-page-smoke';
      const repo = await ZenFSConfigUI.connectV2(APP_ID);
      check('connectV2 返回 AppRepo', repo && repo.appId === APP_ID, repo && repo.appId);
      const group = await repo.getDefaultDataGroup();
      check('getDefaultDataGroup 返回数据组', !!group.id, group.id);
      const infos = await repo.listDataGroups();
      check('listDataGroups 列出已有组', infos.some((item) => item.id === group.id), String(infos.length));
      const sameGroup = await repo.getDataGroup(group.id);
      check('getDataGroup 按 id 取组', sameGroup.id === group.id);
      const events = [];
      const unsubscribe = group.onSyncEvent((event) => events.push(event));
      const added = await group.addBackend({
        id: 'golf-smoke-memory',
        type: 'InMemory',
        options: { label: 'v2-golf-page-smoke-memory' },
      });
      check('addBackend 可用', !!added.backendId, added.backendId);
      await group.fs.promises.writeFile('/golf-probe.txt', 'golf page v2 smoke');
      const text = await group.fs.promises.readFile('/golf-probe.txt', 'utf-8');
      check('group.fs.promises 可读写', text === 'golf page v2 smoke', text);

      const flushed = await group.flush();
      check('group.flush 立即同步并返回结果', Array.isArray(flushed) && flushed.length > 0 && !!flushed[0].pairId, 'pairs=' + flushed.length);
      await new Promise((resolve) => setTimeout(resolve, 600));
      check('收到 sync:start', events.some((event) => event.type === 'sync:start'), String(events.length));
      check('收到 sync:end', events.some((event) => event.type === 'sync:end'), String(events.length));
      const before = events.length;
      unsubscribe();
      await group.flush();
      await new Promise((resolve) => setTimeout(resolve, 300));
      check('取消订阅后不再收到事件', events.length === before, before + ' -> ' + events.length);

      await group.deleteFile('/golf-probe.txt');
      let deleted = false;
      try {
        await group.fs.promises.stat('/golf-probe.txt');
      } catch {
        deleted = true;
      }
      check('deleteFile 走墓碑路径并删除本地文件', deleted);

      const panel = document.createElement('sync-group-configurator-v2');
      panel.setAttribute('app-id', APP_ID);
      panel.repo = repo;
      panel.style.display = 'none';
      document.body.appendChild(panel);
      const panelRepo = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('repo-ready timeout')), 10000);
        panel.addEventListener('repo-ready', (event) => {
          clearTimeout(timer);
          resolve(event.detail);
        }, { once: true });
      });
      check('UI 组件复用传入的 AppRepo', panelRepo === repo);
      check('UI getAppRepo 返回同一个 AppRepo', panel.getAppRepo() === repo);
      panel.remove();
      return { url: location.href, checks };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    if (result.checks.some((item) => !item.ok)) process.exitCode = 1;
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  } finally {
    ws.close();
  }
};
