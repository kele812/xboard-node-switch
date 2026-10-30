#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="${INSTALL_DIR:-/www/docker/xboard-node-switch}"
ARCHIVE_URL='https://codeload.github.com/kele812/xboard-node-switch/tar.gz/refs/heads/main'
die() { printf '\n错误：%s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == 'Linux' ]] || die '此脚本用于 Linux VPS。'
for command in docker curl tar mktemp mkdir date; do
  command -v "$command" >/dev/null 2>&1 || die "缺少 $command，请先安装。"
done
[[ "$APP_DIR" == /* && "$APP_DIR" != '/' ]] || die 'INSTALL_DIR 必须为非根目录的绝对路径。'
[[ -f "$APP_DIR/bot/compose.yaml" && -f "$APP_DIR/bot/Dockerfile" && -d "$APP_DIR/bot/public" ]] || die "未找到现有网页部署：$APP_DIR。请先运行一键部署脚本，或设置正确的 INSTALL_DIR。"
docker info >/dev/null 2>&1 || die 'Docker 未启动或当前账号没有权限。'
docker compose version >/dev/null 2>&1 || die '需要 Docker Compose v2。'

WORK_DIR="$(mktemp -d /tmp/xboard-node-switch-update.XXXXXXXX)"
cleanup() {
  if [[ "$WORK_DIR" == /tmp/xboard-node-switch-update.* && -d "$WORK_DIR" && ! -L "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT
trap 'printf "\n更新未完成，请检查上面的错误。原代码备份及 Docker 数据卷均已保留。\n" >&2' ERR

printf '\n[1/4] 下载最新代码…\n'
curl --fail --location --show-error --retry 3 --connect-timeout 20 --max-time 180 "$ARCHIVE_URL" -o "$WORK_DIR/source.tar.gz"
mkdir "$WORK_DIR/source"
tar -xzf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR/source" --strip-components=1
[[ -f "$WORK_DIR/source/bot/Dockerfile" && -f "$WORK_DIR/source/bot/src/main.mjs" ]] || die '下载内容不完整，未修改现有部署。'

printf '\n[2/4] 备份现有代码，保留本地编排配置…\n'
mkdir -p -- "$APP_DIR/backups"
BACKUP="$APP_DIR/backups/app-$(date +%Y%m%d-%H%M%S)-$$.tar.gz"
tar -czf "$BACKUP" -C "$APP_DIR" bot/src bot/public bot/package.json bot/Dockerfile bot/compose.yaml
# 只更新发布源码，不覆盖本地编排、运行数据或环境配置。
tar -C "$WORK_DIR/source" --exclude='./bot/compose.yaml' --exclude='./deploy/baota-compose.yaml' --exclude='./bot/data' --exclude='./bot/.env' --exclude='./.env' --exclude='./backups' -cf - . | tar -C "$APP_DIR" -xf -

printf '\n[3/4] 重建并启动容器…\n'
docker compose --project-name xboard-node-switch --file "$APP_DIR/bot/compose.yaml" up -d --build

printf '\n[4/4] 等待网页就绪…\n'
ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if docker compose --project-name xboard-node-switch --file "$APP_DIR/bot/compose.yaml" exec -T bot node -e "fetch('http://127.0.0.1:3000/api/session',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  docker compose --project-name xboard-node-switch --file "$APP_DIR/bot/compose.yaml" logs --tail=50 bot
  die "更新后网页未就绪，请检查日志。原代码备份位于 $BACKUP。"
fi

printf '\n更新完成。管理员密码、连接配置、端口映射与数据卷均已保留。\n原代码备份：%s\n当前端口映射：\n' "$BACKUP"
docker compose --project-name xboard-node-switch --file "$APP_DIR/bot/compose.yaml" port bot 3000
printf '\n重新登录网页即可继续使用。Xboard 服务器上的插件不会被此脚本自动更新。\n'
