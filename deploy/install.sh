#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="${INSTALL_DIR:-/www/docker/xboard-node-switch}"
ARCHIVE_URL='https://codeload.github.com/kele812/xboard-node-switch/tar.gz/refs/heads/main'

die() { printf '\n错误：%s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == 'Linux' ]] || die '此脚本用于 Linux VPS。'
for command in docker curl tar mktemp cp mkdir; do
  command -v "$command" >/dev/null 2>&1 || die "缺少 $command。请先在宝塔安装 Docker，并安装 curl、tar。"
done
docker info >/dev/null 2>&1 || die 'Docker 未启动或当前账号无 Docker 权限，请在宝塔检查 Docker 服务。'
docker compose version >/dev/null 2>&1 || die '需要 Docker Compose v2，请在宝塔更新 Docker 管理模块。'

[[ "$APP_DIR" == /* && "$APP_DIR" != '/' ]] || die 'INSTALL_DIR 必须为非根目录的绝对路径。'
if [[ -e "$APP_DIR" || -L "$APP_DIR" ]]; then
  die "目标目录已存在：$APP_DIR。为避免覆盖已有部署，请使用新的 INSTALL_DIR，或按部署说明更新原项目。"
fi

WORK_DIR="$(mktemp -d /tmp/xboard-node-switch.XXXXXXXX)"
cleanup() {
  if [[ "$WORK_DIR" == /tmp/xboard-node-switch.* && -d "$WORK_DIR" && ! -L "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT
trap 'printf "\n部署未完成。已下载的源代码和 Docker 数据卷不会被删除，请检查上面的错误。\n" >&2' ERR

printf '\n[1/3] 下载 Xboard Node Switch…\n'
curl --fail --location --show-error --retry 3 --connect-timeout 20 --max-time 180 "$ARCHIVE_URL" -o "$WORK_DIR/source.tar.gz"
mkdir "$WORK_DIR/source"
tar -xzf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR/source" --strip-components=1
[[ -f "$WORK_DIR/source/bot/Dockerfile" && -f "$WORK_DIR/source/bot/compose.yaml" ]] || die '下载内容不完整。'
mkdir -p -- "$(dirname -- "$APP_DIR")"
mkdir -- "$APP_DIR"
cp -a "$WORK_DIR/source/." "$APP_DIR/"

printf '\n[2/3] 构建并启动网页后台与 Telegram 机器人…\n'
docker compose --project-name xboard-node-switch --file "$APP_DIR/bot/compose.yaml" up -d --build

printf '\n[3/3] 等待网页就绪…\n'
ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8080/api/session >/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  docker compose --project-name xboard-node-switch --file "$APP_DIR/bot/compose.yaml" logs --tail=50 bot
  die '网页未就绪，请检查容器日志与 8080 端口是否被占用。源代码与数据卷已保留。'
fi

printf '\n部署完成。\n网页地址：http://你的VPS_IP:8080\n反代目标：http://127.0.0.1:8080\n项目目录：%s\n\n' "$APP_DIR"
printf '首次初始化码见下方启动日志。Token、白名单和面板地址均在网页填写。\n'
docker compose --project-name xboard-node-switch --file "$APP_DIR/bot/compose.yaml" logs --tail=20 bot
printf '\n提示：Xboard 那台服务器仍需安装 plugins/NodeAddressSwitch 插件。\n'
