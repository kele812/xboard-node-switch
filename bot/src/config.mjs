import { isIP } from 'node:net';

export function validHost(host) {
  return typeof host === 'string' && host.length <= 253 && (isIP(host) !== 0 || /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(host));
}

export function loadConfig(env) {
  const url = new URL(env.XBOARD_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('XBOARD_URL 必须为 HTTPS 根地址');
  const allowed = (env.ALLOWED_USER_IDS ?? '').split(',').map(x => x.trim());
  if (!allowed.length || allowed.some(x => !/^[1-9]\d*$/.test(x))) throw new Error('请配置数字用户 ID 白名单');
  if (!/^\d+:[\w-]+$/.test(env.TELEGRAM_BOT_TOKEN ?? '')) throw new Error('机器人 Token 格式错误');
  if ((env.XBOARD_API_KEY ?? '').length < 32) throw new Error('接口密钥至少 32 字符');
  const presets = JSON.parse(env.ADDRESS_PRESETS || '[]');
  if (!Array.isArray(presets) || presets.length > 20 || presets.some(p => !p || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40 || !validHost(p.host))) throw new Error('预设地址配置无效，最多20个');
  return { url: url.origin, allowed: new Set(allowed), token: env.TELEGRAM_BOT_TOKEN, key: env.XBOARD_API_KEY, presets };
}
