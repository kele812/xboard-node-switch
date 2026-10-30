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
