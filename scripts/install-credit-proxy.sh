#!/bin/bash
# 将积分轮换代理安装为 macOS 常驻服务（LaunchAgent）。
# 需要在【系统终端】里执行，不要在应用内的受限 shell 里执行：
#   bash /Users/xp/WorkBuddy/Worktrees/WorkDaddy/main-c4458fa4/scripts/install-credit-proxy.sh
set -u

LABEL="com.workbuddy.credit-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="/Users/xp/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"
LOG="$HOME/Library/Application Support/WorkDaddy/credit-proxy.log"

# 优先使用安装包内的副本，这样服务不再依赖开发目录；
# 开发目录被清理或移动也不会让常驻服务失效。
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_SCRIPTS="/Applications/WorkDaddy.app/Contents/Resources/scripts"
if [ -f "$APP_SCRIPTS/credit-proxy-standalone.js" ]; then
  SCRIPT="$APP_SCRIPTS/credit-proxy-standalone.js"
  SRC_DIR="$APP_SCRIPTS"
else
  SCRIPT="$SELF_DIR/credit-proxy-standalone.js"
  SRC_DIR="$SELF_DIR"
fi

if [ ! -x "$NODE" ]; then
  echo "✗ 找不到 node: $NODE"
  exit 1
fi
if [ ! -f "$SCRIPT" ]; then
  echo "✗ 找不到启动脚本: $SCRIPT"
  exit 1
fi

echo "→ 写入 $PLIST"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$SCRIPT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WBSWITCH_DATA_DIR</key><string>$HOME/Library/Application Support/WorkDaddy</string>
    <key>WBSWITCH_PROFILE</key><string>workbuddy-cn</string>
    <key>WBSWITCH_CREDIT_PROXY_PORT</key><string>47900</string>
  </dict>
</dict>
</plist>
PLIST_EOF
plutil -lint "$PLIST" >/dev/null || { echo "✗ plist 格式错误"; exit 1; }
echo "  ✓ 已使用: $SCRIPT"

echo "→ 卸载可能存在的旧实例"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "credit-proxy-standalone.js" 2>/dev/null || true

echo "→ 加载 $PLIST"
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>&1; then
  echo "  bootstrap 失败，回退到 launchctl load"
  launchctl load -w "$PLIST" || {
    echo "✗ 两种方式都失败，请确认在系统「终端」中运行，而不是应用内置终端"
    exit 1
  }
fi

sleep 2
echo "→ 自检"
if curl -s -m 5 http://127.0.0.1:47900/healthz >/dev/null; then
  echo "✓ 代理已就绪: http://127.0.0.1:47900"
  curl -s http://127.0.0.1:47900/healthz
  echo
  echo "日志: $LOG"
else
  echo "✗ 端口 47900 无响应，查看日志: $LOG"
  tail -20 "$LOG" 2>/dev/null
  exit 1
fi
