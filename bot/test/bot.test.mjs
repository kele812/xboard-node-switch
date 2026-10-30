import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.mjs';
import { validHost, loadConfig } from '../src/config.mjs';

function setup(options = {}) {
  const sent = [], writes = [], calls = [];
  let clock = 0;
  const nodes = options.nodes || Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `节点${i + 1}`, host: `old${i + 1}.example.com`, type: 'vless' }));
  const bot = new Bot({ allowed: new Set(['123', '456']), presets: [{ name: '备用', host: 'new.example.com' }], ...options.config }, async (method, data) => { sent.push({ method, ...data }); }, async (action, actor, data, panelId) => {
    calls.push({ action, actor, data, panelId });
    if (action === 'nodes') return nodes;
    writes.push({ actor, ...data });
    return { changes: data.nodes };
  }, () => clock);
  const message = text => bot.handle({ message: { from: { id: 123 }, chat: { id: 123, type: 'private' }, text } });
  const click = data => bot.handle({ callback_query: { id: 'cb', data, from: { id: 123 }, message: { chat: { id: 123, type: 'private' } } } });
  const action = (name, value = '') => click(`${bot.sessions.get('123').nonce}:${name}:${value}`);
  return { bot, sent, writes, calls, message, click, action, advance: () => { clock += 16 * 60_000; } };
}

test('地址校验支持域名和 IPv4/IPv6，拒绝 URL、端口和非法输入', () => {
  for (const host of ['a.example.com', '1.2.3.4', '2001:db8::1', 'xn--fiqs8s.example']) assert.ok(validHost(host), host);
  for (const host of ['', 'https://a.example.com', 'a.example.com:443', 'a.example.com/path', '-bad.example', '999.999.999.999', 'a b.com', 'a.example\n', null]) assert.ok(!validHost(host), host);
});

test('配置要求 HTTPS、非空白名单和足够长的密钥', () => {
  const env = { XBOARD_URL: 'https://panel.example.com', TELEGRAM_BOT_TOKEN: '123:abc', ALLOWED_USER_IDS: '123', XBOARD_API_KEY: 'x'.repeat(32) };
  assert.equal(loadConfig(env).url, env.XBOARD_URL);
  for (const invalid of [{ XBOARD_URL: 'http://panel.example.com' }, { ALLOWED_USER_IDS: '' }, { XBOARD_API_KEY: 'short' }, { ADDRESS_PRESETS: '{}' }]) assert.throws(() => loadConfig({ ...env, ...invalid }));
});

test('未授权用户、群聊、伪造聊天 ID 均不能读取节点', async () => {
  const x = setup();
  for (const [user, chat, type] of [[999, 999, 'private'], [123, -123, 'group'], [123, 999, 'private']]) {
    await x.bot.handle({ message: { from: { id: user }, chat: { id: chat, type }, text: '/nodes' } });
    await x.bot.handle({ callback_query: { id: 'bad', from: { id: user }, data: 'bad:confirm', message: { chat: { id: chat, type } } } });
  }
  assert.equal(x.bot.sessions.size, 0);
  assert.equal(x.writes.length, 0);
});

test('跨页多选 + 预设确认仅提交选中的 ID 与原地址', async () => {
  const x = setup();
  await x.message('/nodes');
  await x.action('toggle', 1);
  await x.action('page', 1);
  await x.action('toggle', 10);
  await x.action('next');
  await x.action('preset', 0);
  assert.equal(x.writes.length, 0);
  const confirm = `${x.bot.sessions.get('123').nonce}:confirm`;
  await x.click(confirm);
  await x.click(confirm);
  assert.deepEqual(x.writes, [{ actor: '123', host: 'new.example.com', nodes: [{ id: 1, host: 'old1.example.com' }, { id: 10, host: 'old10.example.com' }] }]);
});

test('手动地址先校验，取消后旧确认无法执行', async () => {
  const x = setup();
  await x.message('/nodes'); await x.action('toggle', 2); await x.action('next'); await x.action('manual');
  await x.message('https://bad.example.com');
  assert.equal(x.bot.sessions.get('123').stage, 'input');
  await x.message('2001:db8::2');
  assert.equal(x.bot.sessions.get('123').host, '2001:db8::2');
  const old = `${x.bot.sessions.get('123').nonce}:confirm`;
  await x.message('/cancel'); await x.click(old);
  assert.equal(x.writes.length, 0);
});

test('过期会话和旧按钮不执行操作', async () => {
  const x = setup();
  await x.message('/nodes');
  const old = `${x.bot.sessions.get('123').nonce}:toggle:1`;
  await x.action('toggle', 2); await x.click(old);
  assert.deepEqual([...x.bot.sessions.get('123').selected], [2]);
  x.advance(); await x.action('next');
  assert.equal(x.bot.sessions.size, 0);
  assert.equal(x.writes.length, 0);
});

test('写请求超时不重试，必须重新读取面板确认', async () => {
  const x = setup(); let attempts = 0;
  const panel = x.bot.panel;
  x.bot.panel = async (...args) => { if (args[0] === 'switch') { attempts++; throw new Error('超时'); } return panel(...args); };
  await x.message('/nodes'); await x.action('toggle', 1); await x.action('next'); await x.action('preset', 0);
  const old = `${x.bot.sessions.get('123').nonce}:confirm`;
  await x.click(old); await x.click(old);
  assert.equal(attempts, 1);
  assert.ok(x.sent.some(m => m.text?.includes('核查实际地址')));
});

test('空选择不能进入替换，取消勾选有效', async () => {
  const x = setup();
  await x.message('/nodes'); await x.action('toggle', 1); await x.action('toggle', 1); await x.action('next');
  assert.equal(x.bot.sessions.get('123').stage, 'select');
  assert.equal(x.writes.length, 0);
});

test('手动输入 IPv6 确认后成功提交', async () => {
  const x = setup();
  await x.message('/nodes'); await x.action('toggle', 3); await x.action('next'); await x.action('manual');
  await x.message('2001:db8::9'); await x.action('confirm');
  assert.deepEqual(x.writes, [{ actor: '123', host: '2001:db8::9', nodes: [{ id: 3, host: 'old3.example.com' }] }]);
});

test('主菜单展示常驻键盘，用户可切换面板且不会混入旧选择或旧确认', async () => {
  const x = setup({ config: { panels: [{ id: 'a', name: '面板 A', presets: [{ name: 'A 备用', host: 'a.example.com' }] }, { id: 'b', name: '面板 B', presets: [{ name: 'B 备用', host: 'b.example.com' }] }] } });
  await x.message('/start');
  assert.equal(x.sent.at(-1).reply_markup.is_persistent, true);
  assert.ok(x.sent.at(-1).reply_markup.keyboard.flat().some(b => b.text === '切换面板'));
  await x.message('/nodes'); await x.action('all'); await x.action('next'); await x.action('preset', 0);
  const oldConfirm = `${x.bot.sessions.get('123').nonce}:confirm`;
  await x.message('切换面板'); await x.action('panel', 'b'); await x.click(oldConfirm);
  assert.equal(x.writes.length, 0); assert.equal(x.bot.sessions.get('123').panelId, 'b');
  assert.equal(x.bot.sessions.get('123').selected.size, 0);
  await x.message('节点管理'); await x.action('all'); await x.action('next'); await x.action('preset', 0); await x.action('confirm');
  assert.equal(x.writes[0].host, 'b.example.com');
  assert.equal(x.calls.find(c => c.action === 'switch').panelId, 'b');
  assert.ok(x.sent.some(m => m.text?.includes('面板 B')));
});

test('搜索 AA 可跨页一键选中40个匹配节点，并可排除其中一个', async () => {
  const nodes = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `${i < 40 ? 'AA' : 'BB'}-节点${i + 1}`, host: `edge${i + 1}.example.com`, type: 'vless' }));
  const x = setup({ nodes });
  await x.message('/nodes'); await x.action('toggle', 50); await x.action('search'); await x.message('aa');
  assert.equal(x.bot.filtered(x.bot.sessions.get('123')).length, 40);
  assert.equal(x.bot.sessions.get('123').selected.size, 0);
  await x.action('all'); assert.equal(x.bot.sessions.get('123').selected.size, 40);
  await x.action('toggle', 2); await x.action('next'); await x.action('manual'); await x.message('new.example.com'); await x.action('confirm');
  assert.equal(x.writes[0].nodes.length, 39);
  assert.ok(x.writes[0].nodes.every(n => n.id <= 40 && n.id !== 2));
});

test('全选超过100个时不悄悄截断，可通过关键词缩小到60个', async () => {
  const nodes = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: `${i < 60 ? 'AA' : 'BB'}-${i}`, host: 'aa.example.com' }));
  const x = setup({ nodes }); await x.message('/nodes'); await x.action('all');
  assert.equal(x.bot.sessions.get('123').selected.size, 0);
  assert.ok(x.sent.at(-1).text.includes('单次上限100个'));
  await x.action('search'); await x.message('AA'); await x.action('all');
  assert.equal(x.bot.sessions.get('123').selected.size, 60);
  // 所有 host 都带 aa；这里只匹配节点名称，BB 节点不会被选中。
  assert.ok([...x.bot.sessions.get('123').selected].every(id => id <= 60));
});

test('无搜索结果不能切换，清除搜索恢复列表且清空选择', async () => {
  const x = setup(); await x.message('搜索节点'); await x.message('不存在的关键词'); await x.action('all'); await x.action('next');
  assert.equal(x.bot.sessions.get('123').stage, 'select'); assert.equal(x.writes.length, 0);
  await x.action('reset'); assert.equal(x.bot.filtered(x.bot.sessions.get('123')).length, 12);
  assert.equal(x.bot.sessions.get('123').selected.size, 0);
});

test('不同 TG 用户的当前面板互不影响', async () => {
  const x = setup({ config: { panels: [{ id: 'a', name: 'A', presets: [] }, { id: 'b', name: 'B', presets: [] }] } });
  await x.message('/start');
  await x.bot.handle({ message: { from: { id: 456 }, chat: { id: 456, type: 'private' }, text: '/start' } });
  await x.message('/panels'); await x.action('panel', 'b');
  assert.equal(x.bot.sessions.get('123').panelId, 'b'); assert.equal(x.bot.sessions.get('456').panelId, 'a');
});
