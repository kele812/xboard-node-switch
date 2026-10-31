'use strict';
const $ = selector => document.querySelector(selector);
const state = { csrf: '', setup: false, config: null, nodes: [], selected: new Set(), page: 0, pageSize: 20, loaded: false, loading: false, preview: null, previewing: false, confirming: false, view: 'nodes' };
const visibilityText = value => value === true ? '开启（订阅显示）' : value === false ? '关闭（订阅隐藏）' : '状态未知';
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function toast(message, error = false) {
  $('#toast-message').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
}
async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  let response;
  try {
    response = await fetch(`/api/${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch { throw new Error('无法连接管理后台，请检查网络；若刚提交切换，请先重新加载节点核查结果。'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('后台返回内容无效，请检查反向代理。'); }
  if (!response.ok) {
    if (response.status === 401 && !['login', 'setup'].includes(path)) showAuth(false);
    throw new Error(result.error || `请求失败（${response.status}）`);
  }
  return result;
}
function on(selector, event, callback) {
  $(selector).addEventListener(event, async e => {
    try { await callback(e); } catch (error) { toast(error.message, true); }
  });
}
function showAuth(setup) {
  state.csrf = '';
  state.setup = setup;
  state.config = null;
  state.nodes = [];
  state.selected.clear();
  $('#loading').hidden = true;
  $('#dashboard').hidden = true;
  $('#auth').hidden = false;
  $('#setup-code-label').hidden = !setup;
  $('#repeat-label').hidden = !setup;
  $('#setup-code').required = setup;
  $('#repeat-password').required = setup;
  $('#auth-title').textContent = setup ? '创建管理员密码' : '管理员登录';
  $('#auth-description').textContent = setup ? '从容器日志复制初始化码，再设置账号和密码。密码允许短密码和纯数字。' : '输入账号和密码。旧版升级用户的账号为 admin，密码保持不变。';
  $('#auth-password').autocomplete = setup ? 'new-password' : 'current-password';
  $('#auth-password').minLength = 1;
  $('#auth-submit').textContent = setup ? '初始化并进入控制台' : '登录控制台';
  $('#auth-password').value = '';
  $('#repeat-password').value = '';
  if ($('#confirm-dialog').open) $('#confirm-dialog').close();
}
async function enterDashboard() {
  $('#auth').hidden = true;
  $('#dashboard').hidden = false;
  $('#loading').hidden = true;
  state.config = await api('config');
  fillSettings();
  $('#config-notice').hidden = !!state.config.panels.length;
  showView(state.config.panels.length ? 'nodes' : 'settings');
  await refreshStatus();
  if (state.config.panels.length) await loadNodes();
}
function showView(view) {
  state.view = view;
  for (const name of ['nodes', 'settings', 'activity']) $(`#view-${name}`).hidden = name !== view;
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  $('#breadcrumb').textContent = { nodes: '节点管理', settings: '连接配置', activity: '运行与记录' }[view];
  if (view === 'activity') refreshActivity().catch(error => toast(error.message, true));
}
function addPreset(container, value = { name: '', host: '' }) {
  if (container.children.length >= 20) return toast('每个面板最多添加 20 个预设地址。', true);
  const row = element('div', 'preset-row');
  for (const [key, title, placeholder, max] of [['name', '预设名称', '例如 香港备用', 40], ['host', '服务器地址', 'hk.example.com', 253]]) {
    const label = element('label', '', title);
    const input = element('input');
    input.dataset.field = key; input.value = value[key]; input.placeholder = placeholder; input.maxLength = max; input.required = true;
    label.append(input); row.append(label);
  }
  const remove = element('button', 'remove-preset', '×');
  remove.type = 'button'; remove.setAttribute('aria-label', '删除此预设'); remove.addEventListener('click', () => row.remove());
  row.append(remove); container.append(row);
}
function panelField(container, key, title, value = '', placeholder = '', type = 'text') {
  const label = element('label', '', title), input = element('input');
  input.dataset.panelField = key; input.value = value; input.placeholder = placeholder; input.type = type;
  input.maxLength = { name: 40, url: 1024, webUserId: 32, key: 512 }[key] || 253;
  if (['name', 'url'].includes(key)) input.required = true;
  if (type === 'password') input.autocomplete = 'new-password';
  label.append(input); container.append(label);
  return input;
}
function addPanel(value = {}) {
  if ($('#panel-editors').children.length >= 20) return toast('最多添加 20 个面板。', true);
  const card = element('section', 'panel settings-section panel-editor');
  card.dataset.panelId = value.id || [...crypto.getRandomValues(new Uint8Array(8))].map(x => x.toString(16).padStart(2, '0')).join('');
  const description = element('div', 'section-description');
  description.append(element('span', 'step', 'PANEL'), element('h2', '', value.name || '新面板'), element('p', 'muted small', '地址和密钥独立保存，切换时仅修改当前面板。'));
  const remove = element('button', 'text-button', '删除此面板'); remove.type = 'button';
  remove.addEventListener('click', () => { if ($('#panel-editors').children.length <= 1) return toast('至少保留一个面板。', true); card.remove(); });
  description.append(remove);
  const fields = element('div', 'form-fields');
  const name = panelField(fields, 'name', '面板名称', value.name || '', '例如 主面板 / 备用面板');
  name.addEventListener('input', () => { description.querySelector('h2').textContent = name.value || '新面板'; });
  panelField(fields, 'url', '面板地址', value.url || '', 'https://panel.example.com', 'url');
  const key = panelField(fields, 'key', '插件接口密钥', '', value.hasKey ? '已保存，留空保持不变' : '至少32字符，与此面板插件端一致', 'password');
  const keyActions = element('div', 'panel-key-actions');
  const generate = element('button', 'secondary', '生成接口密钥'); generate.type = 'button';
  const generated = element('input'); generated.readOnly = true; generated.hidden = true; generated.setAttribute('aria-label', '本次生成的密钥');
  const copy = element('button', 'text-button', '复制密钥'); copy.type = 'button'; copy.hidden = true;
  generate.addEventListener('click', () => { const text = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join(''); key.value = text; generated.value = text; generated.hidden = false; copy.hidden = false; });
  copy.addEventListener('click', async () => { try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(generated.value); toast('密钥已复制，请同步到对应面板插件。'); } else { generated.focus(); generated.select(); toast('密钥已选中，请复制。'); } } catch { generated.focus(); generated.select(); toast('请手动复制选中的密钥。'); } });
  keyActions.append(generate, generated, copy); fields.append(keyActions);
  panelField(fields, 'webUserId', '网页操作用户 ID', value.webUserId || '', '留空使用白名单第一个 ID');
  fields.append(element('p', 'field-hint', '此 ID 需在该面板插件的白名单中。'));
  const presetHeading = element('div', 'panel-presets-heading'); presetHeading.append(element('h3', '', '此面板的预设地址'));
  const presets = element('div', 'panel-presets');
  (value.presets || []).forEach(p => addPreset(presets, p));
  const add = element('button', 'secondary', '＋ 添加预设'); add.type = 'button'; add.addEventListener('click', () => addPreset(presets));
  fields.append(presetHeading, presets, add); card.append(description, fields); $('#panel-editors').append(card);
}
function currentPanel() { return state.config?.panels.find(p => p.id === state.config.selectedPanelId) || state.config?.panels[0]; }
function fillPanelPicker() {
  const panel = currentPanel();
  $('#panel-picker').replaceChildren(...(state.config?.panels || []).map(p => new Option(p.name, p.id)));
  $('#panel-picker').value = panel?.id || '';
  $('#panel-picker').disabled = !panel;
  const select = $('#preset-select'); select.replaceChildren(new Option('手动输入地址', ''));
  (panel?.presets || []).forEach((p, i) => select.add(new Option(`${p.name} · ${p.host}`, String(i))));
  $('#target-host').value = '';
}
function fillSettings() {
  const form = $('#settings-form'), config = state.config;
  form.elements.allowedUserIds.value = config.allowedUserIds || '';
  form.elements.token.value = '';
  form.elements.token.placeholder = config.hasToken ? '已保存，留空保持不变' : '从 BotFather 获取';
  form.elements.botEnabled.checked = config.botEnabled;
  $('#panel-editors').replaceChildren();
  if (config.panels.length) config.panels.forEach(addPanel); else addPanel();
  fillPanelPicker();
}
function readSettings() {
  const form = $('#settings-form');
  return {
    token: form.elements.token.value.trim(), allowedUserIds: form.elements.allowedUserIds.value.trim(),
    botEnabled: form.elements.botEnabled.checked,
    panels: [...$('#panel-editors').children].map(card => ({ id: card.dataset.panelId, ...Object.fromEntries([...card.querySelectorAll('[data-panel-field]')].map(input => [input.dataset.panelField, input.value.trim()])), presets: [...card.querySelector('.panel-presets').children].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.field, input.value.trim()]))) })),
  };
}
function filteredNodes() {
  const search = $('#search').value.trim().toLowerCase();
  return state.nodes.filter(n => !search || `${n.id} ${n.name} ${n.host} ${n.type}`.toLowerCase().includes(search));
}
function currentPageNodes() {
  return filteredNodes().slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
}
function renderNodes() {
  const filtered = filteredNodes();
  const pages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  const rows = $('#node-rows'); rows.replaceChildren();
  for (const node of currentPageNodes()) {
    const row = element('tr', state.selected.has(node.id) ? 'selected' : '');
    const checkCell = element('td', 'check-cell'), check = element('input');
    check.type = 'checkbox'; check.checked = state.selected.has(node.id); check.setAttribute('aria-label', `选择 ${node.name}`);
    check.addEventListener('change', () => {
      if (check.checked && state.selected.size >= 100) { check.checked = false; return toast('每次最多选择 100 个节点。', true); }
      if (check.checked) state.selected.add(node.id); else state.selected.delete(node.id);
      renderNodes();
    });
    checkCell.append(check);
    const name = element('td'); name.append(element('span', 'node-name', node.name), element('span', 'node-id', `#${node.id}`));
    const host = element('td', 'host-text', node.host), protocol = element('td'); protocol.append(element('span', 'protocol', node.type));
    const status = element('td'), toggle = element('button', `visibility-switch ${node.show === true ? 'on' : 'off'}`, typeof node.show === 'boolean' ? node.show ? '开启' : '关闭' : '需升级插件');
    toggle.type = 'button'; toggle.disabled = typeof node.show !== 'boolean' || state.previewing || state.confirming;
    toggle.setAttribute('aria-label', typeof node.show === 'boolean' ? `${node.name}：${visibilityText(node.show)}，点击${node.show ? '关闭' : '开启'}` : `${node.name}：状态未知，请升级插件`);
    if (typeof node.show === 'boolean') { toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(node.show)); }
    toggle.addEventListener('click', () => showPreview({ kind: 'visibility', ids: [node.id], show: !node.show }).catch(error => toast(error.message, true)));
    status.append(toggle); row.append(checkCell, name, host, protocol, status); rows.append(row);
  }
  $('#node-total').textContent = state.nodes.length;
  $('#selected-count').textContent = state.selected.size;
  $('#selection-label').textContent = `已选择 ${state.selected.size} 个节点${state.selected.size ? '，可跨页多选' : ''}`;
  $('#clear-selection').disabled = !state.selected.size;
  $('#select-filtered').disabled = !filtered.length || state.loading;
  $('#select-filtered').textContent = $('#search').value.trim() ? `全选搜索结果（${filtered.length}）` : `全选全部节点（${filtered.length}）`;
  $('#preview-switch').disabled = !state.selected.size || state.loading || state.previewing;
  const selectedNodes = state.nodes.filter(n => state.selected.has(n.id));
  const visibilityReady = selectedNodes.length > 0 && selectedNodes.every(n => typeof n.show === 'boolean') && !state.loading && !state.previewing;
  $('#batch-show').disabled = !visibilityReady;
  $('#batch-hide').disabled = !visibilityReady;
  $('#visibility-notice').hidden = !state.loaded || !state.nodes.some(n => typeof n.show !== 'boolean');
  $('#node-empty').hidden = filtered.length > 0;
  if (!filtered.length) {
    $('#node-empty h3').textContent = state.loading ? '正在加载节点…' : state.loaded ? (state.nodes.length ? '没有匹配的节点' : '面板暂无节点') : '等待加载节点';
    $('#node-empty p').textContent = state.loading ? '正在读取面板当前配置。' : state.loaded ? '可修改搜索条件，或在面板创建节点后刷新。' : '配置连接后，点击右上方“刷新节点”。';
  }
  $('#page-info').textContent = filtered.length ? `共 ${filtered.length} 个 · 第 ${state.page + 1} / ${pages} 页` : '暂无节点';
  $('#prev-page').disabled = state.page === 0;
  $('#next-page').disabled = state.page >= pages - 1;
  const pageNodes = currentPageNodes();
  const chosen = pageNodes.filter(n => state.selected.has(n.id)).length;
  $('#select-page').checked = !!pageNodes.length && chosen === pageNodes.length;
  $('#select-page').indeterminate = chosen > 0 && chosen < pageNodes.length;
  $('#select-page').disabled = !pageNodes.length;
}
async function loadNodes() {
  if (state.loading) return;
  if (!currentPanel()) return showView('settings');
  state.loading = true; state.loaded = false; state.nodes = []; state.selected.clear(); state.preview = null;
  $('#refresh-nodes').disabled = true; $('#panel-picker').disabled = true; renderNodes();
  try {
    state.nodes = await api('nodes'); state.loaded = true; state.page = 0;
  } finally { state.loading = false; $('#refresh-nodes').disabled = false; $('#panel-picker').disabled = false; renderNodes(); }
}
async function refreshStatus() {
  const status = await api('status');
  const titles = { running: '机器人运行中', stopped: '机器人已暂停', error: '连接需要处理', starting: '正在启动', unconfigured: '尚未配置' };
  $('#bot-short').textContent = titles[status.state] || status.state;
  $('#bot-dot').className = `dot ${status.state}`;
  $('#runtime-title').textContent = titles[status.state] || status.state;
  $('#runtime-message').textContent = status.message;
  $('#runtime-username').textContent = status.username ? `@${status.username}` : '—';
  $('#runtime-poll').textContent = time(status.lastPollAt);
  $('#runtime-actor').textContent = status.webUserId || '—';
  if (!$('#new-username').value && document.activeElement !== $('#new-username')) $('#new-username').value = status.username || '';
  $('.admin-badge').textContent = status.username || '管理员';
}
async function refreshActivity() {
  await refreshStatus();
  const records = await api('audit'), list = $('#audit-list'); list.replaceChildren();
  if (!records.length) list.append(element('div', 'audit-empty', '暂无网页切换记录。完成一次切换后，记录将显示在这里。'));
  for (const record of records) {
    const visibility = record.kind === 'visibility';
    const details = element('details', 'audit-entry'), summary = element('summary', '', `${record.panelName || '默认面板'} · ${record.changes.length} 个节点 → ${visibility ? visibilityText(record.show) : record.host}`);
    summary.append(element('span', `audit-state ${record.state}`, { success: '已完成', unknown: '结果待核查', pending: '已提交 · 请核查' }[record.state] || record.state));
    const meta = element('div', 'audit-meta'); meta.append(element('span', '', time(record.at)), element('span', '', `操作身份 ${record.actor}`));
    details.append(summary, meta);
    if (record.message) details.append(element('p', 'small error-text', record.message));
    for (const change of record.changes) details.append(element('div', 'audit-change', `#${change.id} ${change.name}：${visibility ? visibilityText(change.before) : change.before} → ${visibility ? visibilityText(change.after) : change.after}`));
    list.append(details);
  }
}

on('#auth-form', 'submit', async e => {
  e.preventDefault(); $('#auth-error').hidden = true;
  if (state.setup && $('#auth-password').value !== $('#repeat-password').value) { $('#auth-error').textContent = '两次输入的密码不一致'; $('#auth-error').hidden = false; return; }
  $('#auth-submit').disabled = true;
  try {
    const result = await api(state.setup ? 'setup' : 'login', { code: $('#setup-code').value.trim(), username: $('#auth-username').value.trim(), password: $('#auth-password').value });
    state.csrf = result.csrf;
    $('#auth-password').value = ''; $('#repeat-password').value = ''; $('#setup-code').value = '';
    await enterDashboard();
  } catch (error) { $('#auth-error').textContent = error.message; $('#auth-error').hidden = false; toast(error.message, true); }
  finally { $('#auth-submit').disabled = false; }
});
async function logout() { await api('logout', {}); showAuth(false); }
on('#logout', 'click', logout);
on('#logout-mobile', 'click', logout);
for (const nav of document.querySelectorAll('[data-view]')) nav.addEventListener('click', () => showView(nav.dataset.view));
on('#go-settings', 'click', () => showView('settings'));
on('#refresh-nodes', 'click', loadNodes);
on('#panel-picker', 'change', async e => {
  const panelId = e.target.value;
  $('#panel-picker').disabled = true;
  try { await api('panel', { panelId }); state.config.selectedPanelId = panelId; state.preview = null; $('#search').value = ''; fillPanelPicker(); await loadNodes(); await refreshStatus(); }
  finally { $('#panel-picker').disabled = false; }
});
on('#search', 'input', () => { state.page = 0; renderNodes(); });
on('#clear-selection', 'click', () => { state.selected.clear(); renderNodes(); });
on('#prev-page', 'click', () => { state.page--; renderNodes(); });
on('#next-page', 'click', () => { state.page++; renderNodes(); });
on('#select-page', 'change', e => {
  for (const node of currentPageNodes()) {
    if (!e.target.checked) state.selected.delete(node.id);
    else if (state.selected.size < 100) state.selected.add(node.id);
    else if (!state.selected.has(node.id)) toast('每次最多选择 100 个节点。', true);
  }
  renderNodes();
});
on('#select-filtered', 'click', () => {
  const nodes = filteredNodes(); if (nodes.length > 100) return toast('单次最多100个节点，请用名称关键词缩小范围。', true);
  state.selected = new Set(nodes.map(n => n.id)); renderNodes();
});
on('#preset-select', 'change', e => { $('#target-host').value = e.target.value === '' ? '' : currentPanel().presets[Number(e.target.value)].host; });
on('#target-host', 'input', () => { $('#preset-select').value = ''; });
on('#add-panel', 'click', () => addPanel());
on('#settings-form', 'submit', async e => {
  e.preventDefault(); $('#save-config').disabled = true; $('#test-connections').disabled = true;
  try {
    const result = await api('config', readSettings()); state.config = result.config;
    fillSettings(); state.nodes = []; state.selected.clear(); state.loaded = false; state.preview = null; renderNodes();
    $('#config-notice').hidden = true; $('#test-results').hidden = true;
    await refreshStatus(); toast('配置已保存并生效。可前往节点管理加载节点。');
  } finally { $('#save-config').disabled = false; $('#test-connections').disabled = false; }
});
on('#test-connections', 'click', async () => {
  if (!$('#settings-form').reportValidity()) return;
  $('#test-connections').disabled = true; $('#save-config').disabled = true;
  try {
    const result = await api('test', readSettings()); $('#test-results').replaceChildren();
    $('#test-results').append(element('p', result.telegram.ok ? 'test-success' : 'test-failed', `Telegram：${result.telegram.message}`));
    for (const value of result.panels) $('#test-results').append(element('p', value.ok ? 'test-success' : 'test-failed', `${value.name}：${value.message}`));
    $('#test-results').hidden = false;
  } finally { $('#test-connections').disabled = false; $('#save-config').disabled = false; }
});
async function showPreview(data) {
  if (state.previewing || state.confirming) return;
  state.previewing = true; renderNodes();
  try {
    const preview = await api('preview', data); state.preview = preview;
    const visibility = preview.kind === 'visibility';
    const action = visibility ? preview.show ? '开启' : '关闭' : '替换';
    $('#confirm-title').textContent = `确认${visibility ? action + '节点' : '切换地址'} · ${preview.panelName}`;
    $('#confirm-target-label').textContent = visibility ? '目标订阅状态' : '新服务器地址';
    $('#confirm-host').textContent = visibility ? visibilityText(preview.show) : preview.host; $('#confirm-list').replaceChildren();
    for (const node of preview.nodes) {
      const row = element('div', 'confirm-node'); row.append(element('strong', '', `#${node.id} ${node.name}`), element('p', '', visibility ? `${visibilityText(node.show)} → ${visibilityText(preview.show)}` : `${node.host} → ${preview.host}`)); $('#confirm-list').append(row);
    }
    $('#confirm-switch').textContent = `确认${action} ${preview.nodes.length} 个节点`; $('#confirm-dialog').showModal();
  } finally { state.previewing = false; renderNodes(); }
}
on('#preview-switch', 'click', () => showPreview({ kind: 'address', ids: [...state.selected], host: $('#target-host').value.trim() }));
on('#batch-show', 'click', () => showPreview({ kind: 'visibility', ids: [...state.selected], show: true }));
on('#batch-hide', 'click', () => showPreview({ kind: 'visibility', ids: [...state.selected], show: false }));
on('#cancel-confirm', 'click', () => { if (!state.confirming) { state.preview = null; $('#confirm-dialog').close(); } });
$('#confirm-dialog').addEventListener('cancel', e => { if (state.confirming) e.preventDefault(); else state.preview = null; });
on('#confirm-switch', 'click', async () => {
  if (!state.preview || state.confirming) return;
  state.confirming = true; $('#confirm-switch').disabled = true; $('#cancel-confirm').disabled = true;
  const { token, kind, show } = state.preview; state.preview = null;
  try {
    const result = await api('switch', { token });
    toast(kind === 'visibility' ? `已完成：${result.changes.length} 个节点已${show ? '开启' : '关闭'}。客户端更新订阅后可看到变化。` : `已完成：${result.changes.length} 个节点的服务器地址已更新。`);
    await loadNodes();
  } catch (error) { state.nodes = []; state.selected.clear(); state.loaded = false; renderNodes(); toast(`${error.message} 请刷新节点核查当前状态。`, true); }
  finally { state.confirming = false; $('#confirm-switch').disabled = false; $('#cancel-confirm').disabled = false; $('#confirm-dialog').close(); renderNodes(); }
});
on('#refresh-activity', 'click', refreshActivity);
on('#password-form', 'submit', async e => {
  e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true;
  try {
    const username = $('#new-username').value.trim();
    await api('password', { username, currentPassword: $('#current-password').value, newPassword: $('#new-password').value });
    $('#password-form').reset(); showAuth(false); $('#auth-username').value = username; toast('账号设置已更新，请重新登录。');
  } finally { button.disabled = false; }
});
on('#dismiss-toast', 'click', () => { $('#toast').hidden = true; });
setInterval(() => { if (state.csrf && !$('#dashboard').hidden) refreshStatus().catch(() => {}); }, 12_000);
(async () => {
  try {
    const session = await api('session');
    if (session.authenticated) { state.csrf = session.csrf; await enterDashboard(); }
    else showAuth(session.setupRequired);
    renderNodes();
  } catch (error) { $('#loading').hidden = true; toast(error.message, true); }
})();
