#!/bin/zsh
set -euo pipefail

DRY_RUN=0
ASSUME_YES=0
DELAY_SECONDS=0
REMOVE_SERVICES=1
REMOVE_VM=1
REMOVE_SNOWLUMA_ONLY=0
VM_MODE_EXPLICIT=0
REMOVE_APP_DATA=1
REMOVE_APP=1
REMOVE_KEYCHAIN=1
REMOVE_CODEBUDDY=0
CODEBUDDY_EXPLICIT=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --delay)
      DELAY_SECONDS="${2:-0}"
      shift 2
      ;;
    --remove-vm)
      REMOVE_VM=1
      REMOVE_SNOWLUMA_ONLY=0
      VM_MODE_EXPLICIT=1
      shift
      ;;
    --keep-vm)
      REMOVE_VM=0
      VM_MODE_EXPLICIT=1
      shift
      ;;
    --remove-snowluma-only)
      REMOVE_VM=0
      REMOVE_SNOWLUMA_ONLY=1
      VM_MODE_EXPLICIT=1
      shift
      ;;
    --keep-snowluma)
      REMOVE_SNOWLUMA_ONLY=0
      shift
      ;;
    --remove-app-data)
      REMOVE_APP_DATA=1
      shift
      ;;
    --keep-app-data)
      REMOVE_APP_DATA=0
      shift
      ;;
    --remove-app)
      REMOVE_APP=1
      shift
      ;;
    --keep-app)
      REMOVE_APP=0
      shift
      ;;
    --remove-keychain)
      REMOVE_KEYCHAIN=1
      shift
      ;;
    --keep-keychain)
      REMOVE_KEYCHAIN=0
      shift
      ;;
    --remove-codebuddy)
      REMOVE_CODEBUDDY=1
      CODEBUDDY_EXPLICIT=1
      shift
      ;;
    --keep-codebuddy)
      REMOVE_CODEBUDDY=0
      CODEBUDDY_EXPLICIT=1
      shift
      ;;
    --help|-h)
      cat <<'USAGE'
WorkBuddy QQ Gateway 彻底卸载与空间回收工具
用法: uninstall.command [选项]
  --yes               非交互模式，按选定项直接执行
  --dry-run           仅扫描占用并预览动作，不删除任何文件
  --delay <秒>        等待数秒后再执行（供 App 退出让路）
  --remove-vm / --keep-vm             是否删除整个 Colima(snowluma) 虚拟机磁盘 (~10GB)
  --remove-snowluma-only              仅删除虚拟机内的 snowluma 容器、镜像与数据卷（保留虚拟机及其他容器）
  --keep-snowluma                     不单独删除 snowluma 容器与镜像
  --remove-app-data / --keep-app-data 是否删除本地运行数据、Python venv 与缓存
  --remove-app / --keep-app           是否删除应用程序与偏好设置
  --remove-keychain / --keep-keychain 是否删除钥匙串凭据
  --remove-codebuddy / --keep-codebuddy 是否删除 CodeBuddy CLI 与登录态
USAGE
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done

human_size() {
  local p="$1"
  if [ -e "$p" ]; then
    du -sh "$p" 2>/dev/null | awk '{print $1}'
  else
    echo "0B"
  fi
}

if [ "$DELAY_SECONDS" -gt 0 ] 2>/dev/null; then
  sleep "$DELAY_SECONDS"
fi

APP_PATH="/Applications/WorkBuddyQQGateway.app"
SUPPORT_DIR="$HOME/Library/Application Support/WorkBuddyQQGateway"
PREFS_PLIST="$HOME/Library/Preferences/local.workbuddy.qq-agent-gateway.plist"
CACHES_DIR="$HOME/Library/Caches/local.workbuddy.qq-agent-gateway"
RUNNER_DIR="$HOME/.workbuddy-qq-gateway"
COLIMA_PROFILE_DIR="$HOME/.colima/snowluma"
COLIMA_LIMA_DIR="$HOME/.colima/_lima/colima-snowluma"
COLIMA_DISK_DIR="$HOME/.colima/_lima/_disks/colima-snowluma"
CODEBUDDY_BIN="$HOME/.local/bin/codebuddy"
CODEBUDDY_HOME="$HOME/.codebuddy"

echo "================================================================"
echo "  WorkBuddy QQ Gateway · 彻底卸载与空间清理工具"
echo "================================================================"
if [ "$DRY_RUN" = "1" ]; then
  echo "  [演练模式 --dry-run] 仅展示待清理项，不会真正删除任何数据。"
fi
echo ""
echo "当前本机占用扫描："
echo "  1. Colima(snowluma) 虚拟机与容器磁盘 :"
echo "     - $COLIMA_DISK_DIR ($(human_size "$COLIMA_DISK_DIR"))"
echo "     - $COLIMA_LIMA_DIR ($(human_size "$COLIMA_LIMA_DIR"))"
echo "     - $COLIMA_PROFILE_DIR ($(human_size "$COLIMA_PROFILE_DIR"))"
echo "  2. 本地运行数据 / Python venv / 缓存  : $SUPPORT_DIR ($(human_size "$SUPPORT_DIR"))"
echo "  3. 应用程序本体                      : $APP_PATH ($(human_size "$APP_PATH"))"
echo "  4. 钥匙串凭据与启动项                : WorkBuddy QQ Gateway + LaunchAgents"
echo "  5. (可选) CodeBuddy CLI 与登录态      : $CODEBUDDY_HOME ($(human_size "$CODEBUDDY_HOME"))"
echo ""
echo "安全承诺：不会删除你导出的 .laodai-persona.json / .tar.gz 备份与「文稿」「桌面」中的文件。"
echo ""

if [ "$ASSUME_YES" != "1" ]; then
  printf "是否确认停止服务并开始卸载上述项目？输入 yes 继续（默认取消）: "
  read -r confirm
  if [ "$confirm" != "yes" ]; then
    echo "已取消卸载。"
    exit 0
  fi

  if [ "$VM_MODE_EXPLICIT" = "0" ]; then
    echo ""
    echo "请选择 Colima(snowluma) 虚拟机与容器的清理方式："
    echo "  1) 删除整个 Colima(snowluma) 虚拟机磁盘（彻底释放 ~10GB+，同虚拟机内其他容器也会删除）"
    echo "  2) 仅删除虚拟机内的 snowluma 容器、镜像与数据卷（保留虚拟机及其他容器）"
    echo "  3) 完全保留虚拟机与 snowluma 容器"
    printf "请输入选项 [1/2/3，默认 2]: "
    read -r ans_vm
    case "${ans_vm:-2}" in
      1)
        REMOVE_VM=1
        REMOVE_SNOWLUMA_ONLY=0
        ;;
      3)
        REMOVE_VM=0
        REMOVE_SNOWLUMA_ONLY=0
        ;;
      *)
        REMOVE_VM=0
        REMOVE_SNOWLUMA_ONLY=1
        ;;
    esac
  fi

  if [ "$CODEBUDDY_EXPLICIT" = "0" ] && { [ -e "$CODEBUDDY_BIN" ] || [ -d "$CODEBUDDY_HOME" ]; }; then
    printf "是否同时删除 CodeBuddy CLI 与登录缓存 (~/.codebuddy)？[y/N]: "
    read -r ans_cb
    case "${ans_cb:-n}" in
      y|Y|yes|YES) REMOVE_CODEBUDDY=1 ;;
      *) REMOVE_CODEBUDDY=0 ;;
    esac
  fi
fi

run_cmd() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [DRY-RUN] $*"
  else
    "$@"
  fi
}

echo ""
echo "==> 1/5 正在停止 WorkBuddy QQ Gateway、Hub 网关与 LaunchAgents…"
UID_NUM="$(id -u)"
for label in local.workbuddy.qq-agent-gateway.chat-hub local.workbuddy.qq-agent-gateway.qq-runtime local.workbuddy.qq-agent-gateway.login; do
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [DRY-RUN] launchctl bootout gui/$UID_NUM/$label"
  else
    /bin/launchctl bootout "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
    /bin/rm -f "$HOME/Library/LaunchAgents/$label.plist"
  fi
done

if [ "$DRY_RUN" != "1" ]; then
  # Gracefully quit App if still open
  /usr/bin/pkill -x "WorkBuddyQQGateway" >/dev/null 2>&1 || true
  # Terminate any local Hub listening on 3789 verified as src/server.js
  for pid in $(/usr/sbin/lsof -nP -tiTCP:3789 -sTCP:LISTEN 2>/dev/null || true); do
    cmd="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$cmd" in
      *src/server.js*)
        /bin/kill -TERM "$pid" >/dev/null 2>&1 || true
        sleep 1
        /bin/kill -KILL "$pid" >/dev/null 2>&1 || true
        ;;
    esac
  done
  /bin/rm -rf "$RUNNER_DIR"
else
  echo "  [DRY-RUN] 停止 3789 Hub 进程并移除 $RUNNER_DIR"
fi

if [ "$REMOVE_VM" = "1" ]; then
  echo "==> 2/5 正在停止并彻底移除 Colima(snowluma) 虚拟机与容器磁盘…"
  DOCKER_BIN="$(command -v docker || ([ -x /opt/homebrew/bin/docker ] && echo /opt/homebrew/bin/docker) || true)"
  COLIMA_BIN="$(command -v colima || ([ -x /opt/homebrew/bin/colima ] && echo /opt/homebrew/bin/colima) || true)"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [DRY-RUN] 停止并移除 snowluma 容器、colima(snowluma) 实例及磁盘目录"
  else
    if [ -n "$DOCKER_BIN" ]; then
      "$DOCKER_BIN" --context colima-snowluma stop -t 5 snowluma >/dev/null 2>&1 || true
      "$DOCKER_BIN" --context colima-snowluma rm -f snowluma >/dev/null 2>&1 || true
      "$DOCKER_BIN" --context colima-snowluma volume rm -f snowluma-data snowluma-qq-config snowluma-qq-data >/dev/null 2>&1 || true
      "$DOCKER_BIN" context rm -f colima-snowluma >/dev/null 2>&1 || true
    fi
    if [ -n "$COLIMA_BIN" ]; then
      "$COLIMA_BIN" stop --profile snowluma >/dev/null 2>&1 || true
      "$COLIMA_BIN" delete --profile snowluma -f >/dev/null 2>&1 || true
    fi
    /bin/rm -rf "$COLIMA_PROFILE_DIR" "$COLIMA_LIMA_DIR" "$COLIMA_DISK_DIR"
  fi
elif [ "$REMOVE_SNOWLUMA_ONLY" = "1" ]; then
  echo "==> 2/5 正在仅移除虚拟机内的 snowluma 容器、镜像与数据卷（保留 Colima 虚拟机及其他容器）…"
  DOCKER_BIN="$(command -v docker || ([ -x /opt/homebrew/bin/docker ] && echo /opt/homebrew/bin/docker) || true)"
  COLIMA_BIN="$(command -v colima || ([ -x /opt/homebrew/bin/colima ] && echo /opt/homebrew/bin/colima) || true)"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [DRY-RUN] 仅删除 colima-snowluma 内的 snowluma 容器、SnowLuma 镜像及 3 个数据卷，保留虚拟机与其他容器"
  else
    if [ -n "$DOCKER_BIN" ]; then
      if ! "$DOCKER_BIN" --context colima-snowluma info >/dev/null 2>&1; then
        if [ -n "$COLIMA_BIN" ]; then
          echo "  Colima(snowluma) 当前未运行，正在短暂启动以清理容器与镜像…"
          "$COLIMA_BIN" start --profile snowluma >/dev/null 2>&1 || true
        fi
      fi
      if "$DOCKER_BIN" --context colima-snowluma info >/dev/null 2>&1; then
        SNOWL_IMG="$("$DOCKER_BIN" --context colima-snowluma inspect -f '{{.Config.Image}}' snowluma 2>/dev/null || true)"
        "$DOCKER_BIN" --context colima-snowluma stop -t 5 snowluma >/dev/null 2>&1 || true
        "$DOCKER_BIN" --context colima-snowluma rm -f snowluma >/dev/null 2>&1 || true
        "$DOCKER_BIN" --context colima-snowluma volume rm -f snowluma-data snowluma-qq-config snowluma-qq-data >/dev/null 2>&1 || true
        if [ -n "$SNOWL_IMG" ]; then
          "$DOCKER_BIN" --context colima-snowluma rmi -f "$SNOWL_IMG" >/dev/null 2>&1 || true
        fi
        while IFS= read -r img; do
          [ -z "$img" ] && continue
          case "${img:l}" in
            *snowluma*)
              "$DOCKER_BIN" --context colima-snowluma rmi -f "$img" >/dev/null 2>&1 || true
              ;;
          esac
        done < <("$DOCKER_BIN" --context colima-snowluma images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)
        echo "  已清理 snowluma 容器、镜像与数据卷，Colima 虚拟机及其他容器已保留。"
      else
        echo "  ⚠️ 无法连接 colima-snowluma Docker 上下文，跳过容器/镜像清理。"
      fi
    else
      echo "  ⚠️ 未检测到 docker 命令，跳过容器/镜像清理。"
    fi
  fi
else
  echo "==> 2/5 已跳过 Colima 虚拟机与 SnowLuma 容器（--keep-vm）"
fi

if [ "$REMOVE_APP_DATA" = "1" ]; then
  echo "==> 3/5 正在清理本地运行数据、Python 虚拟环境与缓存…"
  run_cmd /bin/rm -rf "$SUPPORT_DIR" "$CACHES_DIR"
else
  echo "==> 3/5 已保留本地运行数据（--keep-app-data）"
fi

if [ "$REMOVE_APP" = "1" ]; then
  echo "==> 4/5 正在移除应用程序本体与偏好设置…"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [DRY-RUN] 移除 $APP_PATH 与 $PREFS_PLIST"
  else
    if [ -e "$APP_PATH" ]; then
      /bin/rm -rf "$APP_PATH" 2>/dev/null || /usr/bin/osascript -e "do shell script \"rm -rf '$APP_PATH'\" with administrator privileges" >/dev/null 2>&1 || true
    fi
    /bin/rm -f "$PREFS_PLIST"
  fi
else
  echo "==> 4/5 已保留应用程序本体（--keep-app）"
fi

if [ "$REMOVE_KEYCHAIN" = "1" ]; then
  echo "==> 清理 macOS 钥匙串条目（WorkBuddy QQ Gateway）…"
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [DRY-RUN] 删除钥匙串服务 WorkBuddy QQ Gateway 下的所有条目"
  else
    for _ in {1..20}; do
      /usr/bin/security delete-generic-password -s "WorkBuddy QQ Gateway" >/dev/null 2>&1 || break
    done
  fi
fi

if [ "$REMOVE_CODEBUDDY" = "1" ]; then
  echo "==> 5/5 正在移除 CodeBuddy 独立 CLI 与登录缓存…"
  run_cmd /bin/rm -rf "$CODEBUDDY_BIN" "$CODEBUDDY_HOME"
else
  echo "==> 5/5 已保留 CodeBuddy CLI 与登录态"
fi

echo ""
echo "================================================================"
if [ "$DRY_RUN" = "1" ]; then
  echo "  演练完成，以上目录均未删除。"
else
  echo "  ✅ WorkBuddy QQ Gateway 卸载与空间回收已完成！"
fi
echo "================================================================"
