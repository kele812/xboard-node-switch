<?php

namespace Plugin\NodeAddressSwitch\Controllers;

use App\Http\Controllers\PluginController;
use App\Models\Server;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class NodeController extends PluginController
{
    private function authorizeBot(Request $request): string
    {
        abort_unless($this->isPluginEnabled(), 403, '插件未启用');
        $key = (string) $this->getConfig('api_key', '');
        abort_unless(strlen($key) >= 32 && hash_equals($key, (string) $request->bearerToken()), 401, '接口认证失败');
        $actor = (string) $request->header('X-Telegram-User-Id', '');
        $allowed = preg_split('/[\s,]+/', (string) $this->getConfig('allowed_user_ids', ''), -1, PREG_SPLIT_NO_EMPTY);
        abort_unless(preg_match('/^[1-9][0-9]*$/D', $actor) && in_array($actor, $allowed, true), 403, '用户没有操作权限');
        return $actor;
    }

    public function nodes(Request $request)
    {
        $this->authorizeBot($request);
        return response()->json(['data' => Server::query()->orderBy('id')->get(['id', 'name', 'type', 'host', 'show'])]);
    }

    public function switchVisibility(Request $request)
    {
        $actor = $this->authorizeBot($request);
        $data = $request->validate([
            'show' => ['required', 'boolean'],
            'nodes' => ['required', 'array', 'min:1', 'max:100'],
            'nodes.*.id' => ['required', 'integer', 'min:1', 'distinct'],
            'nodes.*.show' => ['required', 'boolean'],
        ]);
        abort_unless(is_bool($data['show']), 422, '显隐状态必须是布尔值');
        foreach ($data['nodes'] as $node) {
            abort_unless(is_bool($node['show']), 422, '原显隐状态必须是布尔值');
        }
        $show = $data['show'];
        $changes = DB::transaction(function () use ($data, $show, $actor) {
            $expected = collect($data['nodes'])->keyBy('id');
            $nodes = Server::query()->whereIn('id', $expected->keys())->orderBy('id')->lockForUpdate()->get();
            abort_unless($nodes->count() === $expected->count(), 409, '节点已删除，请重新选择');
            foreach ($nodes as $node) {
                abort_unless((bool) $node->show === $expected[$node->id]['show'], 409, '节点显隐状态已改变，请重新选择');
            }
            $changes = [];
            foreach ($nodes as $node) {
                $changes[] = ['id' => $node->id, 'name' => $node->name, 'before' => (bool) $node->show, 'after' => $show];
                // 只控制订阅显隐，不修改 host、enabled、端口或协议设置。
                $node->show = $show;
                $node->saveOrFail();
            }
            Log::info('node_visibility_switch', ['actor' => $actor, 'changes' => $changes]);
            return $changes;
        });
        return response()->json(['data' => ['changes' => $changes]]);
    }

    public function switchHosts(Request $request)
    {
        $actor = $this->authorizeBot($request);
        $data = $request->validate([
            'host' => ['required', 'string', 'max:253'],
            'nodes' => ['required', 'array', 'min:1', 'max:100'],
            'nodes.*.id' => ['required', 'integer', 'min:1', 'distinct'],
            'nodes.*.host' => ['required', 'string', 'max:253'],
        ]);
        $host = $data['host'];
        $isIp = filter_var($host, FILTER_VALIDATE_IP) !== false;
        $isDomain = preg_match('/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/D', $host);
        abort_unless($isIp || $isDomain, 422, '请输入有效域名或 IP，不要包含协议、端口或路径');

        $changes = DB::transaction(function () use ($data, $host, $actor) {
            $expected = collect($data['nodes'])->keyBy('id');
            $nodes = Server::query()->whereIn('id', $expected->keys())->orderBy('id')->lockForUpdate()->get();
            abort_unless($nodes->count() === $expected->count(), 409, '节点已删除，请重新选择');
            foreach ($nodes as $node) {
                abort_unless((string) $node->host === $expected[$node->id]['host'], 409, '节点地址已改变，请重新选择');
            }
            $changes = [];
            foreach ($nodes as $node) {
                $changes[] = ['id' => $node->id, 'name' => $node->name, 'before' => $node->host, 'after' => $host];
                // 仅赋值 host，保留端口及协议配置；Eloquent 正常维护 updated_at。
                $node->host = $host;
                $node->saveOrFail();
            }
            // 日志记录在事务内；失败会回滚数据库，日志需结合成功响应核对。
            Log::info('node_address_switch', ['actor' => $actor, 'changes' => $changes]);
            return $changes;
        });

        return response()->json(['data' => ['changes' => $changes]]);
    }
}
