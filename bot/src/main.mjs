import { resolve } from 'node:path';
import { createWebApp } from './server.mjs';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
const app = await createWebApp({ directory: resolve(process.env.DATA_DIR || './data'), secureCookie: process.env.COOKIE_SECURE === 'true' });
app.server.listen(port, '0.0.0.0', () => {
  console.log(`网页后台已启动，端口 ${port}`);
  if (!app.store.value.admin) console.log(`首次初始化码（设置管理员密码后自动失效）：${app.store.value.setupCode}`);
});
for (const event of ['SIGTERM', 'SIGINT']) process.on(event, async () => {
  await app.close();
  process.exit(0);
});
