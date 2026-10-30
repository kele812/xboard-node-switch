import { setTimeout as delay } from 'node:timers/promises';
import { Bot } from './bot.mjs';
import { createClients } from './client.mjs';
import { runtimeConfig } from './state.mjs';

export class BotRuntime {
  constructor(clientFactory = createClients) {
    this.clientFactory = clientFactory;
    this.status = { state: 'unconfigured', message: '请先填写连接配置', lastPollAt: null, username: null };
    this.queue = Promise.resolve();
  }
  configure(settings) {
    const job = this.queue.then(async () => {
      await this.stop();
      if (!settings) { this.status = { state: 'unconfigured', message: '请先填写连接配置', lastPollAt: null, username: null }; return; }
      if (!settings.botEnabled) { this.status = { state: 'stopped', message: '机器人已暂停，网页仍可操作', lastPollAt: null, username: null }; return; }
      this.controller = new AbortController();
      this.task = this.run(settings, this.controller.signal);
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async stop() {
    this.controller?.abort();
    await this.task;
    this.task = null;
    this.controller = null;
  }
  async run(settings, signal) {
    const config = runtimeConfig(settings);
    const { telegram } = this.clientFactory(config, undefined, signal);
    const panel = (action, actor, body, panelId) => {
      if (!config.panels.some(p => p.id === panelId)) throw new Error('面板不存在，请重新选择');
      return this.clientFactory(runtimeConfig(settings, panelId), undefined, signal).panel(action, actor, body);
    };
    this.status = { state: 'starting', message: '正在连接 Telegram', lastPollAt: null, username: null };
    while (!signal.aborted) {
      try {
        const me = await telegram('getMe', {});
        const webhook = await telegram('getWebhookInfo', {});
        if (webhook.url) throw new Error('该机器人已有 webhook，请更换专用机器人或先移除旧 webhook');
        await telegram('setMyCommands', { commands: [{ command: 'start', description: '主菜单' }, { command: 'panels', description: '切换面板' }, { command: 'nodes', description: '当前面板节点' }, { command: 'cancel', description: '取消操作' }] });
        const initial = await telegram('getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message', 'callback_query'] });
        let offset = initial.length ? initial.at(-1).update_id + 1 : 0;
        const bot = new Bot(config, telegram, panel);
        this.status = { state: 'running', message: '机器人运行中', username: me.username ?? null, lastPollAt: new Date().toISOString() };
        while (!signal.aborted) {
          const updates = await telegram('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
          this.status.lastPollAt = new Date().toISOString();
          this.status.state = 'running';
          this.status.message = '机器人运行中';
          for (const update of updates) {
            if (signal.aborted) break;
            offset = update.update_id + 1;
            try { await bot.handle(update); }
            catch { if (!signal.aborted) this.status.message = '最近一次交互失败，请在 TG 发送 /nodes 重试'; }
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        this.status.state = 'error';
        this.status.message = error.message;
        await delay(5000, undefined, { signal }).catch(() => {});
      }
    }
  }
}
