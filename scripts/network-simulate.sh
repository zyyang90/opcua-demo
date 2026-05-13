#!/bin/bash
# network-simulate.sh
# macOS 上使用 pfctl 模拟网络断开/恢复
#
# 用法：
#   sudo ./scripts/network-simulate.sh block 192.168.2.139   # 断开到目标 IP 的网络
#   sudo ./scripts/network-simulate.sh unblock               # 恢复网络
#   sudo ./scripts/network-simulate.sh status                 # 查看当前规则

set -e

ACTION=${1:-status}
TARGET_IP=${2:-192.168.2.139}
PF_RULES="/tmp/pf-taosx-test.conf"

case "$ACTION" in
  block)
    echo "=== 断开到 ${TARGET_IP} 的网络 ==="
    echo "block drop out proto tcp from any to ${TARGET_IP}" > "$PF_RULES"
    echo "block drop in proto tcp from ${TARGET_IP} to any" >> "$PF_RULES"
    sudo pfctl -ef "$PF_RULES" 2>/dev/null
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 网络已断开"
    echo "验证: ping -c 1 -W 1 ${TARGET_IP}"
    ping -c 1 -W 1 "${TARGET_IP}" 2>/dev/null && echo "  ⚠️ 仍可达" || echo "  ✅ 已不可达"
    ;;

  unblock)
    echo "=== 恢复网络 ==="
    sudo pfctl -d 2>/dev/null || true
    rm -f "$PF_RULES"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 网络已恢复"
    if [ -n "$TARGET_IP" ]; then
      sleep 1
      echo "验证: ping -c 1 -W 2 ${TARGET_IP}"
      ping -c 1 -W 2 "${TARGET_IP}" 2>/dev/null && echo "  ✅ 可达" || echo "  ⚠️ 仍不可达"
    fi
    ;;

  status)
    echo "=== 当前 pfctl 状态 ==="
    sudo pfctl -s rules 2>/dev/null || echo "pfctl 未启用"
    ;;

  *)
    echo "用法: sudo $0 {block|unblock|status} [target_ip]"
    echo ""
    echo "示例:"
    echo "  sudo $0 block 192.168.2.139    # 断开网络"
    echo "  sudo $0 unblock                # 恢复网络"
    echo "  sudo $0 status                 # 查看状态"
    exit 1
    ;;
esac
