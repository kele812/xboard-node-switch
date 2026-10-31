export function createClients(config, fetcher = fetch, signal) {
  const timeout = ms => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  return {
    async telegram(method, payload) {
      let response, data;
      try {
        response = await fetcher(`https://api.telegram.org/bot${config.token}/${method}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: timeout(45_000), redirect: 'error',
        });
        data = await response.json();
      } catch { throw new Error('Telegram 网络连接失败或响应无效'); }
      if (!response.ok || !data.ok) throw new Error(`Telegram 请求失败（HTTP ${response.status}，代码 ${Number(data.error_code) || 'unknown'}）`);
      return data.result;
    },
    async panel(action, actor, body) {
      let response, data;
      try {
        response = await fetcher(`${config.url}/api/v1/node-address-switch/${action}`, {
          method: body ? 'POST' : 'GET', redirect: 'error',
          headers: { Authorization: `Bearer ${config.key}`, 'X-Telegram-User-Id': String(actor), Accept: 'application/json', 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined, signal: timeout(20_000),
        });
        data = await response.json();
      } catch { throw new Error('面板连接失败、超时或响应无效'); }
      if (!response.ok) {
        const hint = { 401: '接口密钥错误', 403: '插件未启用或用户不在白名单', 404: '插件路由不存在，请检查安装和 Octane 重启', 409: '节点已改变，请重新加载', 422: '节点或地址校验失败', 429: '请求过于频繁，请稍后再试' }[response.status] || '请检查面板日志';
        throw new Error(`面板请求失败（HTTP ${response.status}）：${hint}`);
      }
      if (!data || !('data' in data)) throw new Error('面板返回格式错误');
      if (action === 'nodes') {
        if (!Array.isArray(data.data) || data.data.some(n => !Number.isSafeInteger(n.id) || n.id < 1 || typeof n.name !== 'string' || typeof n.host !== 'string' || n.host.length > 253)) throw new Error('节点列表格式错误');
        // 老插件不返回 show 时标为未知，不能猜测为关闭。
        return data.data.map(({ id, name, type, host, show }) => ({ id, name, type: String(type ?? ''), host, show: typeof show === 'boolean' ? show : null }));
      }
      if (!Array.isArray(data.data.changes)) throw new Error('切换结果格式错误，请重新读取节点核实');
      return data.data;
    },
  };
}
