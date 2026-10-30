import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { StateStore, randomToken, hashPassword, verifyPassword, normalizeUsername, normalizeSettings, runtimeConfig, publicSettings } from './state.mjs';
import { createClients } from './client.mjs';
import { BotRuntime } from './runtime.mjs';
import { validHost } from './config.mjs';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

async function bodyJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, '请求必须使用 JSON');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65_536) fail(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { fail(400, 'JSON 格式错误'); }
}

export async function createWebApp({ directory, secureCookie = false, clientFactory = createClients, runtime = new BotRuntime() }) {
  const store = await new StateStore(directory).open();
  const sessions = new Map(), failures = new Map();
  await runtime.configure(store.value.config);
  const cookie = (id, age = 28_800) => `nas_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookie ? '; Secure' : ''}`;
  const responseJson = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const login = res => {
    const id = randomToken();
    const session = { csrf: randomToken(), expires: Date.now() + 8 * 3600_000 };
    sessions.set(id, session);
    res.setHeader('Set-Cookie', cookie(id));
    return session;
  };
  const clearSnapshots = () => { for (const s of sessions.values()) { delete s.snapshot; delete s.pending; } };
  const rateLimit = req => {
    const now = Date.now();
    for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
    const ip = req.socket.remoteAddress;
    const bucket = failures.get(ip) || { count: 0, until: now + 15 * 60_000 };
    bucket.count++;
    failures.set(ip, bucket);
    if (bucket.count > 10) fail(429, '尝试次数过多，请15分钟后再试');
  };
  const activePanel = session => {
    const panels = store.value.config?.panels || [];
    const panel = panels.find(p => p.id === session.panelId) || panels[0];
    if (panel) session.panelId = panel.id;
    return panel;
  };
  const visibleConfig = session => ({ ...publicSettings(store.value.config), selectedPanelId: activePanel(session)?.id || '' });
  const callPanel = async (settings, panel, action, data) => {
    try { return await clientFactory(runtimeConfig(settings, panel.id)).panel(action, panel.webUserId, data); }
    catch (error) { fail(502, error.message); }
  };

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://local.invalid').pathname;
      if (req.method === 'GET' && assets[path]) {
        const [name, contentType] = assets[path];
        const content = await readFile(new URL(`../public/${name}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': contentType });
        return res.end(content);
      }
      if (!path.startsWith('/api/')) fail(404, '页面不存在');
      // 不信任客户端提供的转发头；同源 JSON + 会话 CSRF 双重约束。
      if (req.method !== 'GET' && req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { fail(403, '来源无效'); }
        if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) fail(403, '仅允许同源操作');
      }
      for (const [id, s] of sessions) if (s.expires < Date.now()) sessions.delete(id);
      const sessionId = /(?:^|;\s*)nas_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = sessions.get(sessionId);
      if (path === '/api/session' && req.method === 'GET') {
        return responseJson(res, 200, { setupRequired: !store.value.admin, authenticated: !!session, csrf: session?.csrf, username: session ? store.value.admin.username : undefined });
      }
      if (path === '/api/setup' && req.method === 'POST') {
        rateLimit(req);
        const data = await bodyJson(req);
        if (store.value.admin) fail(409, '管理员已设置，请登录');
        if (!equal(data.code, store.value.setupCode)) fail(401, '初始化码不正确');
        let admin;
        try { admin = { ...await hashPassword(data.password), username: normalizeUsername(data.username) }; } catch (error) { fail(400, error.message); }
        await store.transact(state => {
          if (state.admin) fail(409, '管理员已设置，请登录');
          state.admin = admin;
          delete state.setupCode;
        });
        const created = login(res);
        return responseJson(res, 200, { csrf: created.csrf });
      }
      if (path === '/api/login' && req.method === 'POST') {
        rateLimit(req);
        const data = await bodyJson(req);
        const passwordMatches = await verifyPassword(data.password, store.value.admin);
        if (!passwordMatches || (typeof data.username === 'string' ? data.username.trim() : '') !== store.value.admin?.username) fail(401, '账号或密码不正确');
        if (sessionId) sessions.delete(sessionId);
        const created = login(res);
        return responseJson(res, 200, { csrf: created.csrf });
      }
      if (!session) fail(401, '请先登录');
      if (req.method !== 'GET' && !equal(req.headers['x-csrf-token'], session.csrf)) fail(403, '会话校验失败，请刷新页面');
      if (path === '/api/logout' && req.method === 'POST') {
        sessions.delete(sessionId);
        res.setHeader('Set-Cookie', cookie('', 0));
        return responseJson(res, 200, { ok: true });
      }
      if (path === '/api/config' && req.method === 'GET') return responseJson(res, 200, visibleConfig(session));
      if (path === '/api/config' && req.method === 'POST') {
        const data = await bodyJson(req);
        await store.transact(state => {
          try { state.config = normalizeSettings(data, state.config || {}); } catch (error) { fail(400, error.message); }
          state.revision = randomToken();
        });
        clearSnapshots();
        await runtime.configure(store.value.config);
        return responseJson(res, 200, { ok: true, config: visibleConfig(session) });
      }
      if (path === '/api/test' && req.method === 'POST') {
        const data = await bodyJson(req);
        let settings;
        try { settings = normalizeSettings(data, store.value.config || {}); } catch (error) { fail(400, error.message); }
        const clients = clientFactory(runtimeConfig(settings));
        const results = await Promise.allSettled([clients.telegram('getMe', {}), ...settings.panels.map(p => clientFactory(runtimeConfig(settings, p.id)).panel('nodes', p.webUserId))]);
        return responseJson(res, 200, {
          telegram: results[0].status === 'fulfilled' ? { ok: true, message: `已连接 @${results[0].value.username || 'bot'}` } : { ok: false, message: results[0].reason.message },
          panels: settings.panels.map((p, i) => ({ id: p.id, name: p.name, ...(results[i + 1].status === 'fulfilled' ? { ok: true, message: `已连接，读取 ${results[i + 1].value.length} 个节点` } : { ok: false, message: results[i + 1].reason.message }) })),
        });
      }
      if (path === '/api/status' && req.method === 'GET') return responseJson(res, 200, { ...runtime.status, configured: !!store.value.config, webUserId: activePanel(session)?.webUserId, selectedPanelId: activePanel(session)?.id, username: store.value.admin.username });
      if (path === '/api/audit' && req.method === 'GET') return responseJson(res, 200, store.value.audit);
      if (path === '/api/password' && req.method === 'POST') {
        rateLimit(req);
        const data = await bodyJson(req);
        const currentAdmin = store.value.admin;
        if (!await verifyPassword(data.currentPassword, currentAdmin)) fail(400, '当前密码不正确');
        const oldHash = currentAdmin.hash;
        let next;
        try { next = { ...(data.newPassword === '' || data.newPassword === undefined ? currentAdmin : await hashPassword(data.newPassword)), username: normalizeUsername(data.username ?? currentAdmin.username) }; } catch (error) { fail(400, error.message); }
        await store.transact(state => {
          if (state.admin.hash !== oldHash) fail(409, '密码已改变，请重新登录');
          state.admin = next;
        });
        sessions.clear();
        res.setHeader('Set-Cookie', cookie('', 0));
        return responseJson(res, 200, { ok: true });
      }
      const settings = store.value.config;
      if (!settings) fail(400, '请先保存连接配置');
      if (path === '/api/panel' && req.method === 'POST') {
        const data = await bodyJson(req);
        if (!settings.panels.some(p => p.id === data.panelId)) fail(404, '面板不存在');
        session.panelId = data.panelId;
        delete session.snapshot;
        delete session.pending;
        return responseJson(res, 200, { panelId: session.panelId });
      }
      const panel = activePanel(session);
      if (path === '/api/nodes' && req.method === 'GET') {
        const revision = store.value.revision;
        const nodes = await callPanel(settings, panel, 'nodes');
        if (revision !== store.value.revision || session.panelId !== panel.id) fail(409, '面板或连接配置已改变，请重新加载节点');
        session.snapshot = { nodes, panelId: panel.id, revision, time: Date.now() };
        delete session.pending;
        return responseJson(res, 200, nodes);
      }
      if (path === '/api/preview' && req.method === 'POST') {
        const data = await bodyJson(req);
        const snapshot = session.snapshot;
        if (!snapshot || snapshot.panelId !== panel.id || snapshot.revision !== store.value.revision || Date.now() - snapshot.time > 15 * 60_000) fail(409, '节点列表已过期，请重新加载');
        if (!validHost(data.host)) fail(400, '请输入有效域名或 IP，不带协议、端口和路径');
        if (!Array.isArray(data.ids) || data.ids.length < 1 || data.ids.length > 100 || data.ids.some(id => !Number.isSafeInteger(id)) || new Set(data.ids).size !== data.ids.length) fail(400, '请勾选 1–100 个不同节点');
        const nodes = data.ids.map(id => snapshot.nodes.find(node => node.id === id));
        if (nodes.some(node => !node)) fail(400, '所选节点不在已读取列表中');
        const pending = { token: randomToken(), panelId: panel.id, panelName: panel.name, host: data.host, nodes, revision: store.value.revision, expires: Date.now() + 5 * 60_000 };
        session.pending = pending;
        return responseJson(res, 200, { token: pending.token, panelName: panel.name, host: pending.host, nodes: pending.nodes });
      }
      if (path === '/api/switch' && req.method === 'POST') {
        const data = await bodyJson(req);
        const pending = session.pending;
        if (!pending || pending.panelId !== panel.id || !equal(data.token, pending.token) || pending.expires < Date.now() || pending.revision !== store.value.revision) fail(409, '确认已失效，请重新选择并预览');
        delete session.pending;
        delete session.snapshot;
        const record = { id: randomToken(), panelId: panel.id, panelName: panel.name, at: new Date().toISOString(), actor: panel.webUserId, state: 'pending', host: pending.host, changes: pending.nodes.map(n => ({ id: n.id, name: n.name, before: n.host, after: pending.host })) };
        // 先持久记录，再向面板写入；崩溃遗留 pending 应按结果未知核查。
        await store.transact(state => { state.audit.unshift(record); state.audit = state.audit.slice(0, 100); });
        let result;
        try {
          result = await callPanel(settings, panel, 'switch', { host: pending.host, nodes: pending.nodes.map(n => ({ id: n.id, host: n.host })) });
        } catch (error) {
          await store.transact(state => { const entry = state.audit.find(a => a.id === record.id); if (entry) { entry.state = 'unknown'; entry.message = error.message; } });
          fail(502, `${error.message}。执行结果需核查，请重新加载节点；不要直接重复提交。`);
        }
        await store.transact(state => { const entry = state.audit.find(a => a.id === record.id); if (entry) entry.state = 'success'; });
        return responseJson(res, 200, result);
      }
      fail(404, '接口不存在');
    } catch (error) {
      if (!res.headersSent) responseJson(res, error.status || 500, { error: error.status ? error.message : '服务处理失败，请检查数据卷权限或稍后重试；若刚执行切换，请先重新读取节点核查结果' });
      else res.end();
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 40;
  return {
    server, store, runtime,
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
      server.closeIdleConnections();
      await runtime.queue;
      await runtime.stop();
      await closed;
      await store.queue;
    },
  };
}
