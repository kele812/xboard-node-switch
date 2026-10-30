import { randomBytes } from 'node:crypto';
import { validHost } from './config.mjs';

const button = (text, callback_data) => ({ text, callback_data });
export class Bot {
  constructor(config, telegram, panel, now = Date.now) {
    Object.assign(this, { config, telegram, panel, now });
    this.sessions = new Map();
  }
  async send(chat, text, rows = []) {
    return this.telegram('sendMessage', { chat_id: chat, text, reply_markup: { inline_keyboard: rows } });
  }
  async handle(update) {
    const cb = update.callback_query;
    const message = cb?.message ?? update.message;
    const actor = cb?.from ?? message?.from;
    if (!message || !actor || message.chat.type !== 'private' || !this.config.allowed.has(String(actor.id)) || String(message.chat.id) !== String(actor.id)) {
      if (cb) await this.telegram('answerCallbackQuery', { callback_query_id: cb.id, text: '没有操作权限，仅允许白名单用户私聊操作' });
      return;
    }
    const id = String(actor.id), chat = message.chat.id;
    if (cb) await this.telegram('answerCallbackQuery', { callback_query_id: cb.id });
    const text = message.text?.trim();
    if (!cb && ['/start', '/nodes'].includes(text)) {
      const nodes = await this.panel('nodes', id);
      if (!Array.isArray(nodes)) throw new Error('节点列表格式错误');
      this.sessions.set(id, { nonce: randomBytes(6).toString('hex'), nodes, selected: new Set(), page: 0, stage: 'select', expires: this.now() + 15 * 60_000 });
      return this.showNodes(id, chat);
    }
    if (!cb && text === '/cancel') {
      this.sessions.delete(id);
      return this.send(chat, '已取消。发送 /nodes 重新选择。');
    }
    const s = this.sessions.get(id);
    if (!s || s.expires < this.now()) {
      this.sessions.delete(id);
      return this.send(chat, '请发送 /nodes 开始，或重新加载已过期的会话。');
    }
    if (!cb) {
      if (s.stage !== 'input') return this.send(chat, '请通过按钮操作。发送 /cancel 取消。');
      if (!validHost(text)) return this.send(chat, '地址无效。请输入域名、IPv4 或 IPv6，不带协议、端口、路径。');
      return this.preview(id, chat, text);
    }
    const [nonce, action, value] = (cb.data ?? '').split(':');
    // 每次渲染轮换 nonce，旧消息和重复点击不再具有操作权。
    if (nonce !== s.nonce) return this.send(chat, '此按钮已过期，请使用最新消息中的按钮或发送 /nodes。');
    s.nonce = randomBytes(6).toString('hex');
    if (action === 'toggle' && s.stage === 'select') {
      const nodeId = Number(value);
      if (s.nodes.some(n => n.id === nodeId)) {
        if (s.selected.has(nodeId)) s.selected.delete(nodeId);
        else if (s.selected.size < 100) s.selected.add(nodeId);
        else return this.showNodes(id, chat, '每次最多选择100个节点。');
      }
      return this.showNodes(id, chat);
    }
    if (action === 'page' && s.stage === 'select') {
      s.page = Math.max(0, Math.min(Number(value) || 0, Math.ceil(s.nodes.length / 8) - 1));
      return this.showNodes(id, chat);
    }
    if (action === 'next' && s.stage === 'select') {
      if (!s.selected.size) return this.showNodes(id, chat, '请至少选择一个节点。');
      s.stage = 'address';
      return this.send(chat, `已选择 ${s.selected.size} 个节点，请选择预设或手动输入：`, [
        ...this.config.presets.map((p, i) => [button(p.name, `${s.nonce}:preset:${i}`)]),
        [button('手动输入地址', `${s.nonce}:manual`)],
      ]);
    }
    if (action === 'manual' && s.stage === 'address') {
      s.stage = 'input';
      return this.send(chat, '请发送新服务器地址（域名或 IP）。发送 /cancel 取消。');
    }
    if (action === 'preset' && s.stage === 'address' && /^\d+$/.test(value ?? '') && this.config.presets[Number(value)]) {
      return this.preview(id, chat, this.config.presets[Number(value)].host);
    }
    if (action === 'confirm' && s.stage === 'confirm') {
      // 在请求前消费确认，写请求不自动重试；网络异常时提示核查实际结果。
      s.stage = 'done';
      const nodes = s.nodes.filter(n => s.selected.has(n.id)).map(n => ({ id: n.id, host: n.host }));
      try {
        const result = await this.panel('switch', id, { host: s.host, nodes });
        this.sessions.delete(id);
        return this.send(chat, `已完成：${result.changes.length} 个节点的服务器地址改为 ${s.host}。\n发送 /nodes 查看最新地址。`);
      } catch (error) {
        this.sessions.delete(id);
        return this.send(chat, `未能确认执行结果：${error.message}\n请发送 /nodes 核查实际地址后再操作。`);
      }
    }
    return this.send(chat, '操作已失效，请发送 /nodes 重新开始。');
  }
  async showNodes(id, chat, note = '') {
    const s = this.sessions.get(id);
    const pages = Math.max(1, Math.ceil(s.nodes.length / 8));
    const rows = s.nodes.slice(s.page * 8, s.page * 8 + 8).map(n => [button(`${s.selected.has(n.id) ? '☑' : '☐'} ${n.id} ${String(n.name).slice(0, 28)} · ${n.host}`.slice(0, 100), `${s.nonce}:toggle:${n.id}`)]);
    rows.push([button('上一页', `${s.nonce}:page:${Math.max(0, s.page - 1)}`), button('下一页', `${s.nonce}:page:${Math.min(pages - 1, s.page + 1)}`)]);
    rows.push([button(`下一步（已选${s.selected.size}个）`, `${s.nonce}:next`)]);
    return this.send(chat, `${note ? note + '\n' : ''}选择要修改的节点（可跨页多选），第 ${s.page + 1}/${pages} 页。\n发送 /cancel 取消。`, rows);
  }
  async preview(id, chat, host) {
    const s = this.sessions.get(id);
    s.host = host;
    s.stage = 'confirm';
    const selected = s.nodes.filter(n => s.selected.has(n.id));
    const header = `即将修改 ${selected.length} 个节点，仅更改服务器地址：\n新地址：${host}\n`;
    // 分段发送全部原地址，避免 Telegram 4096 字符限制。
    let chunk = header;
    for (const n of selected) {
      const line = `\n#${n.id} ${String(n.name).slice(0, 80)}\n${n.host} → ${host}\n`;
      if (chunk.length + line.length > 3500) { await this.send(chat, chunk); chunk = ''; }
      chunk += line;
    }
    if (chunk) await this.send(chat, chunk);
    return this.send(chat, '确认执行？发送 /cancel 可取消。', [[button('确认替换', `${s.nonce}:confirm`)]]);
  }
}
