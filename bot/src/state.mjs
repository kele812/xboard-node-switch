import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { loadConfig } from './config.mjs';

const scrypt = promisify(scryptCallback);
export const randomToken = () => randomBytes(32).toString('hex');
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 128) throw new Error('密码不能为空，最多 128 个字符');
  const salt = randomToken();
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}
export async function verifyPassword(password, admin) {
  if (!admin || typeof password !== 'string' || password.length > 128) return false;
  const actual = await scrypt(password, admin.salt, 64);
  const expected = Buffer.from(admin.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalizeUsername(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('账号不能为空，最多 64 个字符');
  return value.trim();
}

export class StateStore {
  constructor(directory) { this.directory = directory; this.queue = Promise.resolve(); }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.value = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('数据文件无法读取，请检查数据卷；为避免丢失配置，服务已停止');
      this.value = { schemaVersion: 2, setupCode: randomToken(), admin: null, config: null, revision: randomToken(), audit: [] };
      await this.save(this.value);
    }
    if (!this.value || !Array.isArray(this.value.audit) || (!this.value.admin && !this.value.setupCode) || !this.value.revision) throw new Error('数据文件格式无效');
    if (this.value.schemaVersion !== 2) {
      // 升级前保留原始文件；已有密码散列、密钥和白名单原样迁移。
      try { await writeFile(join(this.directory, 'state-v1-backup.json'), JSON.stringify(this.value, null, 2), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const migrated = structuredClone(this.value);
      if (migrated.admin && !migrated.admin.username) migrated.admin.username = 'admin';
      const old = migrated.config;
      if (old && !Array.isArray(old.panels)) {
        migrated.config = { token: old.token, allowedUserIds: old.allowedUserIds, botEnabled: old.botEnabled, panels: [{ id: 'default', name: '默认面板', url: old.url, key: old.key, webUserId: old.webUserId, presets: old.presets || [] }] };
      }
      migrated.schemaVersion = 2;
      await this.save(migrated);
      this.value = migrated;
    }
    return this;
  }
  async save(value) {
    const temporary = join(this.directory, 'state.json.tmp');
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, join(this.directory, 'state.json'));
  }
  transact(mutator) {
    const result = this.queue.then(async () => {
      const next = structuredClone(this.value);
      await mutator(next);
      await this.save(next);
      this.value = next;
    });
    this.queue = result.catch(() => {});
    return result;
  }
}

export function normalizeSettings(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置格式错误');
  const text = value => typeof value === 'string' ? value.trim() : '';
  const token = text(input.token) || previous.token || '';
  if (!Array.isArray(input.panels) || input.panels.length < 1 || input.panels.length > 20) throw new Error('请配置 1–20 个面板');
  const ids = new Set();
  let allowedUserIds;
  const panels = input.panels.map(panel => {
    if (!panel || !/^[a-zA-Z0-9_-]{1,32}$/.test(panel.id) || ids.has(panel.id)) throw new Error('面板标识无效或重复');
    ids.add(panel.id);
    const name = text(panel.name);
    if (!name || name.length > 40) throw new Error('面板名称需要 1–40 个字符');
    const old = previous.panels?.find(p => p.id === panel.id);
    const key = text(panel.key) || old?.key || '';
    let parsed;
    try { parsed = loadConfig({ XBOARD_URL: text(panel.url), ALLOWED_USER_IDS: text(input.allowedUserIds), TELEGRAM_BOT_TOKEN: token, XBOARD_API_KEY: key, ADDRESS_PRESETS: JSON.stringify(panel.presets) }); }
    catch (error) { throw new Error(`${name}：${error.message === 'Invalid URL' ? '请填写有效的 Xboard HTTPS 根地址' : error.message}`); }
    allowedUserIds = [...parsed.allowed].join(',');
    const webUserId = text(panel.webUserId) || [...parsed.allowed][0];
    if (!parsed.allowed.has(webUserId)) throw new Error(`${name}：网页操作用户 ID 必须包含在白名单中`);
    return { id: panel.id, name, url: parsed.url, key, webUserId, presets: parsed.presets.map(({ name, host }) => ({ name: name.trim(), host })) };
  });
  return { token, allowedUserIds, botEnabled: input.botEnabled === true, panels };
}
export function runtimeConfig(settings, panelId = settings.panels?.[0]?.id) {
  const panels = settings.panels || [{ id: 'default', name: '默认面板', ...settings }];
  const panel = panels.find(p => p.id === panelId) || panels[0];
  return { ...panel, panels, token: settings.token, allowed: new Set(settings.allowedUserIds.split(',')) };
}
export function publicSettings(settings) {
  if (!settings) return { allowedUserIds: '', panels: [], botEnabled: false, hasToken: false };
  return { allowedUserIds: settings.allowedUserIds, botEnabled: settings.botEnabled, hasToken: !!settings.token, panels: settings.panels.map(({ key, ...panel }) => ({ ...panel, hasKey: !!key })) };
}
