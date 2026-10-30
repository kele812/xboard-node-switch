import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebApp } from '../src/server.mjs';
import { publicSettings, normalizeSettings, StateStore, verifyPassword } from '../src/state.mjs';
import { createClients } from '../src/client.mjs';

const password = 'test-admin-password-2026';
const panel = { id: 'a', name: '面板 A', url: 'https://panel.example.com', key: 'k'.repeat(64), webUserId: '456', presets: [{ name: '备用 A', host: 'new.example.com' }] };
const settings = { token: '123:fake_test_token', allowedUserIds: '123,456', botEnabled: false, panels: [panel] };

async function fixture(t) {
  const root = resolve(fileURLToPath(new URL('../../.qa/test-data/', import.meta.url)));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'node-switch-test-'));
  const nodes = [{ id: 1, name: '<img src=x onerror=alert(1)>', host: 'one.example.com', type: 'vless' }, { id: 2, name: '节点二', host: 'two.example.com', type: 'trojan' }];
  const writes = [], configured = [], requests = [];
  let failWrite = false;
  const clientFactory = config => ({
    telegram: async () => ({ username: 'test_bot' }),
    panel: async (action, actor, data) => {
      requests.push({ action, actor, url: config.url, key: config.key, panelId: config.id });
      if (action === 'nodes') return structuredClone(nodes).map(n => ({ ...n, host: config.id === 'b' ? `b-${n.host}` : n.host }));
      writes.push({ actor, data });
      if (failWrite) throw new Error('面板连接失败或超时');
      return { changes: data.nodes.map(n => ({ id: n.id, before: n.host, after: data.host })) };
    },
  });
  const runtime = { status: { state: 'stopped', message: '测试暂停' }, queue: Promise.resolve(), async configure(s) { configured.push(s); }, async stop() {} };
  const app = await createWebApp({ directory, clientFactory, runtime });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '', csrf = '';
  const request = async (path, data, headers = {}) => {
    const response = await fetch(`${origin}/api/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const setup = async (username = 'admin', initialPassword = password) => { const result = await request('setup', { code: app.store.value.setupCode, username, password: initialPassword }); assert.equal(result.status, 200); csrf = result.data.csrf; return result; };
  t.after(async () => { await app.close(); assert.equal(dirname(resolve(directory)), root); await rm(directory, { recursive: true, force: true }); });
  return { app, request, setup, directory, nodes, writes, requests, origin, configured, setCsrf: value => { csrf = value; }, failWrite: () => { failWrite = true; } };
}

test('初始化、登录、敏感配置与持久化', async t => {
  const x = await fixture(t);
  assert.equal((await x.request('config')).status, 401);
  assert.equal((await x.request('session')).data.setupRequired, true);
  assert.equal((await x.request('setup', { code: 'wrong', password })).status, 401);
  const login = await x.setup();
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(x.app.store.value.setupCode, undefined);
  const saved = await x.request('config', settings);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.config.hasToken, true);
  assert.equal(saved.data.config.token, undefined);
  const returned = await x.request('config');
  assert.equal(returned.data.key, undefined);
  assert.ok(!JSON.stringify(returned.data).includes(panel.key));
  const reopened = await new StateStore(x.directory).open();
  assert.equal(reopened.value.config.token, settings.token);
  assert.notEqual(reopened.value.admin.hash, password);
  assert.ok(!(await readFile(join(x.directory, 'state.json'), 'utf8')).includes(password));
  assert.equal((await x.request('setup', { code: 'invalid', password })).status, 409);
});

test('跨源、缺少 CSRF 和未登录写入被拒绝', async t => {
  const x = await fixture(t);
  assert.equal((await x.request('config', settings)).status, 401);
  await x.setup();
  assert.equal((await x.request('config', settings, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await x.request('config', settings, { Origin: 'https://evil.example.com' })).status, 403);
  assert.equal(x.app.store.value.config, null);
});

test('网页多选预览、确认防重，只提交选中节点及 host', async t => {
  const x = await fixture(t); await x.setup(); await x.request('config', settings);
  await x.request('nodes');
  const preview = await x.request('preview', { ids: [2], host: 'new.example.com' });
  assert.equal(preview.status, 200); assert.equal(x.writes.length, 0);
  const replies = await Promise.all([x.request('switch', { token: preview.data.token }), x.request('switch', { token: preview.data.token })]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(x.writes, [{ actor: '456', data: { host: 'new.example.com', nodes: [{ id: 2, host: 'two.example.com' }] } }]);
  const audit = await x.request('audit');
  assert.equal(audit.data[0].state, 'success');
  assert.equal(audit.data[0].changes[0].id, 2);
});

test('配置更新使旧节点快照和待确认操作失效，空敏感字段保留原值', async t => {
  const x = await fixture(t); await x.setup(); await x.request('config', settings); await x.request('nodes');
  const preview = await x.request('preview', { ids: [1], host: 'new.example.com' });
  assert.equal((await x.request('config', { ...settings, token: '', allowedUserIds: '123', panels: [{ ...panel, key: '', webUserId: '123' }] })).status, 200);
  assert.equal(x.app.store.value.config.token, settings.token);
  assert.equal(x.app.store.value.config.panels[0].key, panel.key);
  assert.equal((await x.request('switch', { token: preview.data.token })).status, 409);
  assert.equal((await x.request('preview', { ids: [1], host: 'other.example.com' })).status, 409);
  assert.equal(x.writes.length, 0);
});

test('非法目标地址、重复 ID、未知 ID 和空选择不能预览', async t => {
  const x = await fixture(t); await x.setup(); await x.request('config', settings); await x.request('nodes');
  for (const data of [{ ids: [1], host: 'https://a.com' }, { ids: [], host: 'a.com' }, { ids: [1, 1], host: 'a.com' }, { ids: [999], host: 'a.com' }]) assert.equal((await x.request('preview', data)).status, 400);
  assert.equal(x.writes.length, 0);
});

test('切换网络失败只请求一次，并保留待核查记录', async t => {
  const x = await fixture(t); await x.setup(); await x.request('config', settings); await x.request('nodes'); x.failWrite();
  const preview = await x.request('preview', { ids: [1, 2], host: '2001:db8::1' });
  const result = await x.request('switch', { token: preview.data.token });
  assert.equal(result.status, 502); assert.match(result.data.error, /核查/);
  assert.equal((await x.request('switch', { token: preview.data.token })).status, 409);
  assert.equal(x.writes.length, 1);
  assert.equal((await x.request('audit')).data[0].state, 'unknown');
});

test('测试连接不保存配置，网页身份须在白名单中', async t => {
  const x = await fixture(t); await x.setup();
  const result = await x.request('test', settings);
  assert.equal(result.data.telegram.ok, true); assert.equal(result.data.panels[0].ok, true);
  assert.equal(x.app.store.value.config, null);
  assert.equal((await x.request('config', { ...settings, panels: [{ ...panel, webUserId: '999' }] })).status, 400);
});

test('修改密码使所有会话失效，可用新密码登录', async t => {
  const x = await fixture(t); await x.setup();
  assert.equal((await x.request('password', { currentPassword: 'wrong', newPassword: 'new-test-password-2026' })).status, 400);
  assert.equal((await x.request('password', { currentPassword: password, newPassword: 'new-test-password-2026' })).status, 200);
  assert.equal((await x.request('config')).status, 401);
  assert.equal((await x.request('login', { username: 'admin', password })).status, 401);
  assert.equal((await x.request('login', { username: 'admin', password: 'new-test-password-2026' })).status, 200);
});

test('静态页面含 CSP，不能访问数据文件', async t => {
  const x = await fixture(t);
  const html = await fetch(x.origin);
  assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await html.text(), /节点管理/);
  assert.equal((await fetch(`${x.origin}/data/state.json`)).status, 404);
});

test('公开配置不包含敏感字段，校验拒绝 HTTP 和无效预设', () => {
  assert.equal(publicSettings(settings).key, undefined);
  assert.throws(() => normalizeSettings({ ...settings, panels: [{ ...panel, url: 'http://panel.example.com' }] }));
  assert.throws(() => normalizeSettings({ ...settings, panels: [{ ...panel, presets: [{ name: 'bad', host: 'https://a.com' }] }] }));
});

test('客户端发送专用密钥及操作者，拒绝重定向且不泄露远端错误内容', async () => {
  const sent = [];
  const clients = createClients({ ...panel, token: settings.token }, async (url, options) => { sent.push({ url, options }); return new Response(JSON.stringify({ data: [] }), { status: 200 }); });
  await clients.panel('nodes', '456');
  assert.equal(sent[0].options.redirect, 'error');
  assert.equal(sent[0].options.headers.Authorization, `Bearer ${panel.key}`);
  assert.equal(sent[0].options.headers['X-Telegram-User-Id'], '456');
  const bad = createClients(settings, async () => new Response(JSON.stringify({ message: 'secret-from-server' }), { status: 401 }));
  await assert.rejects(bad.panel('nodes', '456'), error => error.message.includes('401') && !error.message.includes('secret-from-server'));
});

test('账号必须正确，支持1位弱密码，修改账号可保留原密码', async t => {
  const x = await fixture(t); await x.setup('my-account', '1');
  assert.equal((await x.request('login', { username: 'wrong', password: '1' })).status, 401);
  assert.equal((await x.request('login', { password: '1' })).status, 401);
  const relogin = await x.request('login', { username: 'my-account', password: '1' });
  assert.equal(relogin.status, 200); x.setCsrf(relogin.data.csrf);
  assert.equal((await x.request('password', { username: 'renamed', currentPassword: '1', newPassword: '' })).status, 200);
  const renamed = await x.request('login', { username: 'renamed', password: '1' });
  assert.equal(renamed.status, 200); x.setCsrf(renamed.data.csrf);
  assert.equal((await x.request('password', { username: 'renamed', currentPassword: '1', newPassword: '123' })).status, 200);
  assert.equal((await x.request('login', { username: 'renamed', password: '123' })).status, 200);
});

test('多个面板的相同节点ID按面板隔离，切换面板使旧确认失效', async t => {
  const x = await fixture(t); await x.setup();
  const b = { ...panel, id: 'b', name: '面板 B', url: 'https://b.example.com', key: 'b'.repeat(64), webUserId: '123' };
  assert.equal((await x.request('config', { ...settings, panels: [panel, b] })).status, 200);
  await x.request('nodes'); const old = await x.request('preview', { ids: [1], host: 'new.example.com' });
  assert.equal((await x.request('panel', { panelId: 'b' })).status, 200);
  assert.equal((await x.request('switch', { token: old.data.token })).status, 409);
  assert.equal((await x.request('panel', { panelId: 'missing' })).status, 404);
  const nodes = await x.request('nodes'); assert.equal(nodes.data[0].host, 'b-one.example.com');
  const preview = await x.request('preview', { ids: [1], host: 'new-b.example.com' });
  assert.equal(preview.data.panelName, '面板 B');
  assert.equal((await x.request('switch', { token: preview.data.token })).status, 200);
  const write = x.requests.find(r => r.action === 'switch');
  assert.deepEqual(write, { action: 'switch', actor: '123', panelId: 'b', url: b.url, key: b.key });
  assert.equal(x.writes[0].data.nodes[0].host, 'b-one.example.com');
  assert.equal((await x.request('audit')).data[0].panelId, 'b');
});

test('面板重排时按稳定ID保留各自密钥，默认面板可重命名和删除', async t => {
  const x = await fixture(t); await x.setup();
  const b = { ...panel, id: 'b', name: '面板 B', url: 'https://b.example.com', key: 'b'.repeat(64) };
  await x.request('config', { ...settings, panels: [panel, b] });
  assert.equal((await x.request('config', { ...settings, token: '', panels: [{ ...b, name: '备用面板', key: '' }, { ...panel, key: '' }] })).status, 200);
  assert.equal(x.app.store.value.config.panels[0].key, b.key);
  assert.equal(x.app.store.value.config.panels[1].key, panel.key);
  const visible = (await x.request('config')).data;
  assert.ok(visible.panels.every(p => p.key === undefined && p.hasKey));
  assert.equal((await x.request('config', { ...settings, panels: [{ ...b, key: '' }] })).status, 200);
  assert.equal(x.app.store.value.config.panels.length, 1);
  assert.equal((await x.request('config', { ...settings, panels: [] })).status, 400);
  assert.equal((await x.request('config', { ...settings, panels: [b, b] })).status, 400);
  assert.equal((await x.request('config', { ...settings, panels: [{ ...b, id: 'new', key: '' }] })).status, 400);
});

test('旧版数据升级保留原密码和所有连接字段，默认账号admin且备份只生成一次', async t => {
  const x = await fixture(t); await x.setup();
  const legacy = structuredClone(x.app.store.value); delete legacy.schemaVersion; delete legacy.admin.username;
  legacy.config = { token: settings.token, allowedUserIds: settings.allowedUserIds, botEnabled: false, url: panel.url, key: panel.key, webUserId: panel.webUserId, presets: panel.presets };
  const originalHash = legacy.admin.hash;
  await x.app.store.save(legacy); await x.app.close();
  const migrated = await new StateStore(x.directory).open();
  assert.equal(migrated.value.admin.username, 'admin'); assert.equal(migrated.value.admin.hash, originalHash);
  assert.equal(await verifyPassword(password, migrated.value.admin), true);
  assert.equal(migrated.value.config.token, settings.token);
  assert.deepEqual(migrated.value.config.panels[0], { id: 'default', name: '默认面板', url: panel.url, key: panel.key, webUserId: panel.webUserId, presets: panel.presets });
  const backup = await readFile(join(x.directory, 'state-v1-backup.json'), 'utf8');
  assert.equal(JSON.parse(backup).admin.hash, originalHash);
  await new StateStore(x.directory).open();
  assert.equal(await readFile(join(x.directory, 'state-v1-backup.json'), 'utf8'), backup);
});
