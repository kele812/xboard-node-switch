# Xboard 网页后台与 Telegram 节点地址管理 · v1.1

通过网页或 Telegram 多选节点，将它们的服务器地址统一切换为手动输入或预设的域名/IP。网页与机器人运行在一个 Docker 容器中，可与 Xboard 分开部署。

v1.1 起，Token、白名单、面板地址、密钥、预设地址全部在网页填写，不再使用业务配置 .env 文件。

## 一键部署（Linux VPS / 宝塔）

在已安装并启动 Docker、Docker Compose v2 的 VPS 执行：

```bash
curl -fsSL https://raw.githubusercontent.com/kele812/xboard-node-switch/main/deploy/install.sh -o /tmp/xboard-node-switch-install.sh && bash /tmp/xboard-node-switch-install.sh
```

命令下载本仓库部署脚本，随后下载源码到 `/www/docker/xboard-node-switch`，构建并启动容器，等待网页就绪并显示初始化码。目标目录已存在时停止，不覆盖已有文件；Docker 数据卷不会被删除。

成功后访问 `http://VPS_IP:20888`，复制日志中的初始化码并设置管理员密码；业务配置全部在网页填写。可自行反代到 `http://127.0.0.1:20888`。端口需可访问；真实凭据建议在 HTTPS 反代完成后填写。

Xboard 插件仍需安装到面板服务器。此命令仅部署网页后台与机器人。完整界面步骤见 [宝塔部署说明](宝塔部署说明.md)。

## 文件

- `plugins/NodeAddressSwitch`：Xboard 原生插件；插件版本仍为 1.0.0，接口未改变。
- `bot`：网页后台与 TG 机器人，Node.js 22+，无第三方运行依赖。
- `deploy/baota-compose.yaml`：宝塔可直接粘贴的编排模板。
- `宝塔部署说明.md`：按界面操作的部署步骤。

## 使用流程

1. 在 Xboard 安装插件，配置专用接口密钥和 Telegram 数字用户 ID 白名单，启用后重启 Octane。
2. 在机器人 VPS 部署 Docker 编排，访问 `http://VPS_IP:20888`。
3. 从宝塔容器日志复制首次初始化码，在网页创建管理员密码（12–128 个字符）。初始化码随后失效。
4. 在“连接配置”填写 Xboard HTTPS 根地址、接口密钥、机器人 Token、用户白名单和预设地址。
5. 网页操作身份填一个两端均已授权的 Telegram 用户 ID；留空则使用白名单第一个 ID。网页登录管理员拥有此身份的节点操作权限。
6. 点击“测试连接”验证两端，再保存配置。测试连接本身不保存。启用机器人后自动启动，修改配置时自动重启机器人。
7. 在“节点管理”刷新列表、勾选节点、输入或选择目标地址，预览新旧地址并确认；或使用白名单账号私聊 TG 机器人发送 `/nodes`。

网页管理员密码与 TG 用户 ID 白名单分别控制网页和 TG 的访问权限。停止 TG 机器人不会停止网页节点管理。

## 运行与数据

默认容器端口 3000，映射宿主机端口 20888。数据位于 `/app/data/state.json`，由 Docker 命名卷 `xboard_node_switch_data` 持久保存。重建容器保留配置、密码和最近 100 条网页操作记录；登录会话在进程重启后失效。

- 管理密码使用 scrypt 加盐散列存储。
- Token 和接口密钥需由服务端调用上游，保存在数据卷中；只允许服务用户读取，API 不回显。备份数据卷时按凭据文件保管。
- 敏感输入留空可保留已保存值。生成接口密钥时会临时显示以便复制到 Xboard 插件；保存后隐藏。
- 网页记录包含操作者 ID、新旧地址。TG 操作记录在 Xboard 日志中，事件名 `node_address_switch`。
- 会话有效期 8 小时；更改管理员密码会使所有会话失效。
- 反代使用根路径，保留原始 Host 请求头。完成 HTTPS 反代后可添加 `COOKIE_SECURE: "true"` 环境变量；此时使用 HTTPS 访问。

通过 HTTP 访问时浏览器与后台之间是明文传输，填入真实凭据前请按你的计划完成 HTTPS 反代。

## 地址修改行为

只赋值 Xboard 的 `host` 字段，并正常维护修改时间，不修改端口、TLS、SNI 和协议配置。每次选择 1–100 个节点，统一使用同一新地址。支持域名、IPv4、IPv6，不接受协议前缀、端口、路径或逗号分隔的多地址。

插件事务检查每个节点仍存在且当前地址等于读取时的原地址，任意冲突时整批拒绝。网页列表快照有效 15 分钟，确认有效 5 分钟；确认一次消费，配置改变后旧快照和确认失效。切换网络失败不自动重试，请重新加载节点核对结果。

客户端需要更新订阅才能获取新地址。本项目不修改 DNS、网络接口，也不部署或重启节点后端。

机器人只接受白名单用户私聊，支持跨页多选、手动地址、预设地址和一次性确认按钮。`/cancel` 取消。配置更新或进程重启会清空待确认 TG 会话。启动或重新初始化 Telegram 连接时会跳过积压消息，避免处理旧操作。已有 webhook 时只报错，不自动删除；同一个 Token 只运行一个机器人实例。

## 本地运行与验证

在 `bot` 目录执行 `npm start`：启动网页后台，默认 `http://localhost:3000`，本地配置存储在 `bot/data`。无需 npm install。

执行 `npm test`：运行离线单元测试和 HTTP 集成测试。测试使用临时目录及模拟服务，不访问真实 Telegram/Xboard，不修改真实节点。

本次 22 项测试通过，并在浏览器验证了配置保存、连接测试、选择节点、预设预览、确认切换与手机布局。开发机没有 PHP、Docker，因此尚未运行镜像构建或 PHP/Laravel 实际集成；上线前需在测试面板验证插件。

测试面板验证步骤：

1. 使用 `php -l` 检查插件 PHP 语法；使用 `php artisan route:list --path=node-address-switch` 检查路由。
2. 空密钥或错误密钥应拒绝，非白名单用户应拒绝。
3. 用两个测试节点仅勾选其中一个，检查另一个不变，端口与完整协议设置均不变。
4. 多选两个测试节点切换，核对两者服务器地址都更新。
5. 开启确认后在 Xboard 修改其中一个原地址，再确认，应整批拒绝且不覆盖任何节点。
6. 非白名单账号与群聊都不能使用 TG 机器人。

## 插件接口

`GET /api/v1/node-address-switch/nodes` 只返回 id/name/type/host。

`POST /api/v1/node-address-switch/switch` 请求 JSON：

```json
{"host":"new.example.com","nodes":[{"id":1,"host":"old.example.com"}]}
```

请求需携带 `Authorization: Bearer <专用密钥>` 和 `X-Telegram-User-Id: <白名单用户 ID>`。专用密钥认证服务端，用户 ID 由服务端传入，不是 Telegram 签名。接口每来源 IP 每分钟最多 60 次。

## 兼容依据

根据 2026-10-30 核对的 cedar2025/Xboard master 原生插件机制与统一 `App\Models\Server` 模型实现。旧版分协议节点表不适用；实际部署版本仍需联调。

- [Xboard 插件开发指南](https://github.com/cedar2025/Xboard/blob/master/docs/en/development/plugin-development-guide.md)
- [插件路由加载机制](https://github.com/cedar2025/Xboard/blob/master/app/Services/Plugin/PluginManager.php)
- [统一节点模型](https://github.com/cedar2025/Xboard/blob/master/app/Models/Server.php)
- [Telegram Bot API](https://core.telegram.org/bots/api)
