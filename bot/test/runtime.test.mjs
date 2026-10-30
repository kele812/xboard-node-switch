import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BotRuntime } from '../src/runtime.mjs';

const settings = { url: 'https://panel.example.com', token: '123:test_token', key: 'x'.repeat(64), allowedUserIds: '123', webUserId: '123', presets: [], botEnabled: true };
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.fail('运行状态未在预期时间内改变');
}

test('保存新配置中止旧轮询，不产生重复机器人实例；暂停后网页服务可继续运行', async () => {
  let active = 0, peak = 0, totalPolls = 0;
  const runtime = new BotRuntime((config, unused, signal) => ({
    panel: async () => [],
    telegram: async (method, data) => {
      if (method === 'getMe') return { username: config.token === settings.token ? 'old_bot' : 'new_bot' };
      if (method === 'getWebhookInfo') return { url: '' };
      if (method === 'setMyCommands') return true;
      if (data.timeout === 0) return [];
      active++; totalPolls++; peak = Math.max(peak, active);
      try { await delay(10_000, undefined, { signal }); return []; } finally { active--; }
    },
  }));
  try {
    await runtime.configure(settings); await until(() => active === 1);
    assert.equal(runtime.status.username, 'old_bot');
    await runtime.configure({ ...settings, token: '456:new_token' }); await until(() => active === 1 && totalPolls === 2);
    assert.equal(runtime.status.username, 'new_bot'); assert.equal(peak, 1);
    await runtime.configure({ ...settings, botEnabled: false });
    assert.equal(runtime.status.state, 'stopped'); assert.equal(active, 0);
  } finally { await runtime.stop(); }
});

test('已有 webhook 时报告错误，不删除 webhook、不开始轮询，停止可中断重连等待', async () => {
  const calls = [];
  const runtime = new BotRuntime(() => ({ panel: async () => [], telegram: async method => { calls.push(method); return method === 'getMe' ? { username: 'test_bot' } : { url: 'https://existing.example.com/hook' }; } }));
  try {
    await runtime.configure(settings); await until(() => runtime.status.state === 'error');
    assert.match(runtime.status.message, /webhook/);
    assert.deepEqual(calls, ['getMe', 'getWebhookInfo']);
  } finally { await runtime.stop(); }
});

test('真实运行适配层按 TG 当前面板选择 URL 和密钥，并注册菜单命令', async () => {
  const panels = [{ id: 'a', name: 'A', url: 'https://a.example.com', key: 'a'.repeat(64), presets: [] }, { id: 'b', name: 'B', url: 'https://b.example.com', key: 'b'.repeat(64), presets: [{ name: 'B 备用', host: 'new-b.example.com' }] }];
  const sent = [], calls = [], commands = [];
  let step = 0;
  const message = text => ({ message: { from: { id: 123 }, chat: { id: 123, type: 'private' }, text } });
  const callback = label => {
    const rows = [...sent].reverse().find(m => m.reply_markup?.inline_keyboard?.flat().some(b => b.text.startsWith(label)))?.reply_markup.inline_keyboard;
    assert.ok(rows, `未找到按钮 ${label}`);
    return { callback_query: { id: `cb${step}`, from: { id: 123 }, message: { chat: { id: 123, type: 'private' } }, data: rows.flat().find(b => b.text.startsWith(label)).callback_data } };
  };
  const runtime = new BotRuntime((config, unused, signal) => ({
    panel: async (action, actor, body) => { calls.push({ action, actor, body, url: config.url, key: config.key }); return action === 'nodes' ? [{ id: 1, name: 'AA-1', host: 'old-b.example.com' }] : { changes: body.nodes }; },
    telegram: async (method, data) => {
      if (method === 'getMe') return { username: 'test_bot' };
      if (method === 'getWebhookInfo') return { url: '' };
      if (method === 'setMyCommands') { commands.push(...data.commands); return true; }
      if (method === 'sendMessage') { sent.push(data); return {}; }
      if (method === 'answerCallbackQuery') return true;
      if (data.timeout === 0) return [];
      const actions = [() => message('/panels'), () => callback('B'), () => message('/nodes'), () => callback('全选全部节点'), () => callback('选择目标地址'), () => callback('B 备用'), () => callback('确认替换')];
      if (step < actions.length) { const update = actions[step](); return [{ ...update, update_id: ++step }]; }
      await delay(10_000, undefined, { signal }); return [];
    },
  }));
  try {
    await runtime.configure({ ...settings, panels }); await until(() => calls.some(c => c.action === 'switch'));
    assert.ok(commands.some(c => c.command === 'panels'));
    assert.ok(calls.every(c => c.url === panels[1].url && c.key === panels[1].key));
    const write = calls.find(c => c.action === 'switch');
    assert.equal(write.body.host, 'new-b.example.com'); assert.equal(write.actor, '123');
  } finally { await runtime.stop(); }
});
