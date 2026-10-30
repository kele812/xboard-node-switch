import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { loadConfig } from './config.mjs';

const scrypt = promisify(scryptCallback);
export const randomToken = () => randomBytes(32).toString('hex');
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('管理员密码需要 12–128 个字符');
  const salt = randomToken();
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}
export async function verifyPassword(password, admin) {
  if (!admin || typeof password !== 'string' || password.length > 128) return false;
  const actual = await scrypt(password, admin.salt, 64);
  const expected = Buffer.from(admin.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class StateStore {
  constructor(directory) { this.directory = directory; this.queue = Promise.resolve(); }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.value = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('数据文件无法读取，请检查数据卷；为避免丢失配置，服务已停止');
      this.value = { setupCode: randomToken(), admin: null, config: null, revision: randomToken(), audit: [] };
      await this.save(this.value);
    }
    if (!this.value || !Array.isArray(this.value.audit) || (!this.value.admin && !this.value.setupCode) || !this.value.revision) throw new Error('数据文件格式无效');
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
  const text = (key, fallback = '') => typeof input[key] === 'string' ? input[key].trim() : fallback;
  const settings = {
    url: text('url'), allowedUserIds: text('allowedUserIds'),
    token: text('token') || previous.token || '', key: text('key') || previous.key || '',
    presets: input.presets, webUserId: text('webUserId'), botEnabled: input.botEnabled === true,
  };
  let parsed;
  try {
    parsed = loadConfig({ XBOARD_URL: settings.url, ALLOWED_USER_IDS: settings.allowedUserIds, TELEGRAM_BOT_TOKEN: settings.token, XBOARD_API_KEY: settings.key, ADDRESS_PRESETS: JSON.stringify(settings.presets) });
  } catch (error) { throw new Error(error.message === 'Invalid URL' ? '请填写有效的 Xboard HTTPS 根地址' : error.message); }
  settings.url = parsed.url;
  settings.allowedUserIds = [...parsed.allowed].join(',');
  settings.webUserId ||= [...parsed.allowed][0];
  if (!parsed.allowed.has(settings.webUserId)) throw new Error('网页操作用户 ID 必须包含在白名单中');
  settings.presets = parsed.presets.map(({ name, host }) => ({ name: name.trim(), host }));
  return settings;
}
export function runtimeConfig(settings) {
  return { url: settings.url, token: settings.token, key: settings.key, allowed: new Set(settings.allowedUserIds.split(',')), presets: settings.presets };
}
export function publicSettings(settings) {
  if (!settings) return { url: '', allowedUserIds: '', webUserId: '', presets: [], botEnabled: false, hasToken: false, hasKey: false };
  const { token, key, ...safe } = settings;
  return { ...safe, hasToken: !!token, hasKey: !!key };
}
