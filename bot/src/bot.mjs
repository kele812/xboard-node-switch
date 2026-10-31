import { randomBytes } from 'node:crypto';
import { validHost } from './config.mjs';

const button = (text, callback_data) => ({ text, callback_data });
const nonce = () => randomBytes(6).toString('hex');
export class Bot {
  constructor(config, telegram, panel, now = Date.now) {
    Object.assign(this, { config, telegram, panel, now });
    this.panels = config.panels || [{ id: 'default', name: '默认面板', presets: config.presets || [] }];
    this.sessions = new Map();
  }
  fresh(panelId) {
    return { nonce: nonce(), panelId: this.panels.some(p => p.id === panelId) ? panelId : this.panels[0].id, nodes: [], selected: new Set(), query: '', page: 0, stage: 'home', expires: this.now() + 15 * 60_000 };
  }
  current(s) { return this.panels.find(p => p.id === s.panelId); }
  filtered(s) { return s.nodes.filter(n => !s.query || n.name.toLowerCase().includes(s.query.toLowerCase())); }
  async send(chat, text, rows = []) {
    return this.telegram('sendMessage', { chat_id: chat, text, reply_markup: { inline_keyboard: rows } });
  }
  async menu(id, chat, note = '') {
    const s = this.sessions.get(id);
    return this.telegram('sendMessage', { chat_id: chat, text: `${note ? note + '\n\n' : ''}当前面板：${this.current(s).name}\n请选择菜单。开启＝订阅显示，关闭＝订阅隐藏。`, reply_markup: { keyboard: [[{ text: '主菜单' }, { text: '切换面板' }], [{ text: '节点管理' }, { text: '搜索节点' }], [{ text: '节点开关' }, { text: '取消操作' }]], resize_keyboard: true, is_persistent: true } });
  }
  async panelsMenu(id, chat) {
    const s = this.sessions.get(id);
    s.stage = 'panels'; s.nodes = []; s.selected.clear(); delete s.host;
    return this.send(chat, `当前面板：${this.current(s).name}\n选择要操作的面板：`, [...this.panels.map(p => [button(`${p.id === s.panelId ? '✓ ' : ''}${p.name}`, `${s.nonce}:panel:${p.id}`)]), [button('返回主菜单', `${s.nonce}:home`)]]);
  }
  async loadNodes(id) {
    const old = this.sessions.get(id);
    const nodes = await this.panel('nodes', id, undefined, old.panelId);
    if (!Array.isArray(nodes)) throw new Error('节点列表格式错误');
    const s = this.fresh(old.panelId); s.nodes = nodes; s.stage = 'select';
    this.sessions.set(id, s);
    return s;
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
    const text = cb ? undefined : message.text?.trim();
    let s = this.sessions.get(id);
    if (!cb && ['/start', '/menu', '主菜单', '/cancel', '取消操作', '/panels', '切换面板', '/nodes', '/visibility', '节点管理', '搜索节点', '节点开关'].includes(text)) {
      const previous = s?.panelId;
      s = this.fresh(previous); this.sessions.set(id, s);
      if (['/panels', '切换面板'].includes(text)) return this.panelsMenu(id, chat);
      if (['/nodes', '/visibility', '节点管理', '搜索节点', '节点开关'].includes(text)) {
        try { s = await this.loadNodes(id); } catch (error) { return this.menu(id, chat, `读取失败：${error.message}`); }
        if (text === '搜索节点') { s.stage = 'search'; return this.send(chat, `当前面板：${this.current(s).name}\n请输入节点名称关键词，例如 AA。`); }
        return this.showNodes(id, chat);
      }
      return this.menu(id, chat, ['/cancel', '取消操作'].includes(text) ? '已取消当前操作。' : '');
    }
    if (!s || s.expires < this.now()) {
      this.sessions.delete(id);
      return this.send(chat, '会话已过期，请发送 /start 打开主菜单。');
    }
    if (!cb) {
      if (s.stage === 'search') {
        if (!text || text.length > 80) return this.send(chat, '请输入 1–80 个字符的节点名称关键词。');
        s.query = text; s.page = 0; s.selected.clear(); s.stage = 'select'; s.nonce = nonce();
        return this.showNodes(id, chat);
      }
      if (s.stage !== 'input') return this.send(chat, '请使用菜单或按钮操作。发送 /start 返回主菜单。');
      if (!validHost(text)) return this.send(chat, '地址无效。请输入域名、IPv4 或 IPv6，不带协议、端口、路径。');
      s.nonce = nonce();
      return this.preview(id, chat, text);
    }
    const [token, action, value] = (cb.data ?? '').split(':');
    if (token !== s.nonce) return this.send(chat, '此按钮已过期，请使用最新消息中的按钮或发送 /start。');
    s.nonce = nonce();
    if (action === 'home') { this.sessions.set(id, this.fresh(s.panelId)); return this.menu(id, chat); }
    if (action === 'panels') return this.panelsMenu(id, chat);
    if (action === 'panel' && s.stage === 'panels' && this.panels.some(p => p.id === value)) {
      this.sessions.set(id, this.fresh(value)); return this.menu(id, chat, '已切换面板，原节点选择已清空。');
    }
    if (action === 'back' && ['address', 'confirm', 'input', 'search'].includes(s.stage)) { s.stage = 'select'; delete s.host; delete s.kind; delete s.show; return this.showNodes(id, chat); }
    if (s.stage === 'select') {
      const filtered = this.filtered(s);
      if (action === 'search') { s.stage = 'search'; return this.send(chat, `当前面板：${this.current(s).name}\n请输入节点名称关键词，例如 AA。搜索后会清空之前的选择。`, [[button('返回节点', `${s.nonce}:back`)]]); }
      if (action === 'reset') { s.query = ''; s.page = 0; s.selected.clear(); return this.showNodes(id, chat); }
      if (action === 'clear') { s.selected.clear(); return this.showNodes(id, chat); }
      if (['all', 'allnodes'].includes(action)) {
        const candidates = action === 'allnodes' ? s.nodes : filtered;
        if (candidates.length > 100) return this.showNodes(id, chat, `共 ${candidates.length} 个节点，单次上限100个，请先用名称关键词缩小范围。`);
        s.selected = new Set(candidates.map(n => n.id));
        if (action === 'allnodes') { s.query = ''; s.page = 0; }
        return this.showNodes(id, chat);
      }
      if (action === 'toggle') {
        const nodeId = Number(value);
        if (filtered.some(n => n.id === nodeId)) {
          if (s.selected.has(nodeId)) s.selected.delete(nodeId);
          else if (s.selected.size < 100) s.selected.add(nodeId);
          else return this.showNodes(id, chat, '每次最多选择100个节点。');
        }
        return this.showNodes(id, chat);
      }
      if (action === 'page') { s.page = Math.max(0, Math.min(Number(value) || 0, Math.ceil(filtered.length / 8) - 1)); return this.showNodes(id, chat); }
      if (['show', 'hide'].includes(action)) {
        if (!s.selected.size) return this.showNodes(id, chat, '请至少选择一个节点。');
        if (s.nodes.filter(n => s.selected.has(n.id)).some(n => typeof n.show !== 'boolean')) return this.showNodes(id, chat, '当前面板插件未提供显隐状态，请升级插件至1.1.0后重新加载节点。');
        return this.previewVisibility(id, chat, action === 'show');
      }
      if (action === 'next') {
        if (!s.selected.size) return this.showNodes(id, chat, '请至少选择一个节点。');
        s.stage = 'address';
        return this.send(chat, `当前面板：${this.current(s).name}\n已选择 ${s.selected.size} 个节点，请选择预设或手动输入：`, [
          ...this.current(s).presets.map((p, i) => [button(p.name, `${s.nonce}:preset:${i}`)]),
          [button('手动输入地址', `${s.nonce}:manual`)], [button('返回节点', `${s.nonce}:back`)], [button('返回主菜单', `${s.nonce}:home`)],
        ]);
      }
    }
    if (action === 'manual' && s.stage === 'address') { s.stage = 'input'; return this.send(chat, `当前面板：${this.current(s).name}\n请发送新服务器地址（域名或 IP）。`, [[button('返回节点', `${s.nonce}:back`)]]); }
    if (action === 'preset' && s.stage === 'address' && /^\d+$/.test(value ?? '') && this.current(s).presets[Number(value)]) return this.preview(id, chat, this.current(s).presets[Number(value)].host);
    if (action === 'confirm' && s.stage === 'confirm') {
      s.stage = 'done';
      const visibility = s.kind === 'visibility';
      const nodes = s.nodes.filter(n => s.selected.has(n.id)).map(n => visibility ? { id: n.id, show: n.show } : { id: n.id, host: n.host });
      let note;
      try {
        const result = await this.panel(visibility ? 'visibility' : 'switch', id, visibility ? { show: s.show, nodes } : { host: s.host, nodes }, s.panelId);
        note = visibility ? `已完成：${this.current(s).name} 的 ${result.changes.length} 个节点已${s.show ? '开启（订阅中显示）' : '关闭（订阅中隐藏）'}。客户端更新订阅后可看到变化。` : `已完成：${this.current(s).name} 的 ${result.changes.length} 个节点服务器地址已改为 ${s.host}。`;
      } catch (error) { note = `未能确认执行结果：${error.message}\n请先通过“节点管理”核查实际${visibility ? '显隐状态' : '地址'}，再进行下一步。`; }
      this.sessions.set(id, this.fresh(s.panelId));
      return this.menu(id, chat, note);
    }
    return this.send(chat, '操作已失效，请发送 /start 重新开始。');
  }
  async showNodes(id, chat, note = '') {
    const s = this.sessions.get(id), nodes = this.filtered(s);
    const pages = Math.max(1, Math.ceil(nodes.length / 8));
    const rows = nodes.slice(s.page * 8, s.page * 8 + 8).map(n => [button(`${s.selected.has(n.id) ? '☑' : '☐'} ${n.id} ${String(n.name).slice(0, 28)} [${typeof n.show === 'boolean' ? n.show ? '开启' : '关闭' : '状态未知'}] · ${n.host}`.slice(0, 100), `${s.nonce}:toggle:${n.id}`)]);
    rows.push([button('上一页', `${s.nonce}:page:${Math.max(0, s.page - 1)}`), button('下一页', `${s.nonce}:page:${Math.min(pages - 1, s.page + 1)}`)]);
    rows.push([button(`${s.query ? '全选搜索结果' : '全选全部节点'}（${nodes.length}个）`, `${s.nonce}:all`), button('清空选择', `${s.nonce}:clear`)]);
    rows.push([button('搜索节点', `${s.nonce}:search`), ...(s.query ? [button('清除搜索', `${s.nonce}:reset`)] : [])]);
    if (s.query) rows.push([button(`全选全部节点（${s.nodes.length}个）`, `${s.nonce}:allnodes`)]);
    rows.push([button(`选择目标地址（已选${s.selected.size}个）`, `${s.nonce}:next`)]);
    rows.push([button('开启所选（订阅显示）', `${s.nonce}:show`), button('关闭所选（订阅隐藏）', `${s.nonce}:hide`)]);
    rows.push([button('切换面板', `${s.nonce}:panels`), button('返回主菜单', `${s.nonce}:home`)]);
    return this.send(chat, `${note ? note + '\n\n' : ''}当前面板：${this.current(s).name}\n${s.query ? `名称包含“${s.query}”：${nodes.length} 个匹配节点` : `全部节点：${nodes.length} 个`}\n已选 ${s.selected.size} 个 · 第 ${s.page + 1}/${pages} 页\n勾选或全选后，可切换地址或开启/关闭订阅显示。`, rows);
  }
  async preview(id, chat, host) {
    const s = this.sessions.get(id); s.host = host; s.kind = 'address'; s.stage = 'confirm';
    const selected = s.nodes.filter(n => s.selected.has(n.id));
    let chunk = `当前面板：${this.current(s).name}\n即将修改 ${selected.length} 个节点，仅更改服务器地址：\n新地址：${host}\n`;
    for (const n of selected) {
      const line = `\n#${n.id} ${String(n.name).slice(0, 80)}\n${n.host} → ${host}\n`;
      if (chunk.length + line.length > 3500) { await this.send(chat, chunk); chunk = ''; }
      chunk += line;
    }
    if (chunk) await this.send(chat, chunk);
    return this.send(chat, `确认替换“${this.current(s).name}”的 ${selected.length} 个节点？`, [[button('确认替换', `${s.nonce}:confirm`)], [button('返回节点', `${s.nonce}:back`), button('返回主菜单', `${s.nonce}:home`)]]);
  }
  async previewVisibility(id, chat, show) {
    const s = this.sessions.get(id); s.show = show; s.kind = 'visibility'; s.stage = 'confirm'; delete s.host;
    const selected = s.nodes.filter(n => s.selected.has(n.id));
    const target = show ? '开启（订阅中显示）' : '关闭（订阅中隐藏）';
    let chunk = `当前面板：${this.current(s).name}\n将 ${selected.length} 个节点设为${target}。仅修改订阅显隐。\n`;
    for (const n of selected) {
      const line = `\n#${n.id} ${String(n.name).slice(0, 80)}\n${n.show ? '开启' : '关闭'} → ${show ? '开启' : '关闭'}\n`;
      if (chunk.length + line.length > 3500) { await this.send(chat, chunk); chunk = ''; }
      chunk += line;
    }
    if (chunk) await this.send(chat, chunk);
    return this.send(chat, `确认${show ? '开启' : '关闭'}“${this.current(s).name}”的 ${selected.length} 个节点？`, [[button(show ? '确认开启' : '确认关闭', `${s.nonce}:confirm`)], [button('返回节点', `${s.nonce}:back`), button('返回主菜单', `${s.nonce}:home`)]]);
  }
}
