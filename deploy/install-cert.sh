#!/usr/bin/env bash
#
# 给 AGenWebsite 换/装 HTTPS 证书（阿里云「Nginx」格式包里的 pem + key）。
#
# 用法（本地仓库根目录，Git Bash）：
#   bash deploy/install-cert.sh ~/Downloads/www.example.com.pem ~/Downloads/www.example.com.key
#
# 它做的事：上传证书 → 落到 /etc/nginx/ssl/（600，root）→ 校验证书与私钥配对
# → 装上 nginx-agen.conf / snippets/agen-app.conf / nginx-agen-ssl.conf
# → nginx -t → reload → 用 openssl 验证证书链。
#
# ⚠️ 证书只落在服务器上，**绝不进 git**（私钥进库等于公开）。
# ⚠️ 换证书不需要动 Nginx 配置，只要文件名还是 agen.online.pem / agen.online.key。
#    换域名时这两行路径（在 deploy/nginx-agen-ssl.conf 里）要一起改。
#
# 续期提醒：证书有效期 3 个月（阿里云 DV）。到期前重新下载 → 再跑一次本脚本即可。
# 查剩余天数：ssh agen-root 'openssl x509 -in /etc/nginx/ssl/agen.online.pem -noout -enddate'

set -euo pipefail

PEM="${1:-}"
KEY="${2:-}"
HOST="${CERT_HOST:-agen-root}"       # ~/.ssh/config 里的 root 别名
REMOTE_DIR="/etc/nginx/ssl"
REMOTE_PEM="$REMOTE_DIR/agen.online.pem"
REMOTE_KEY="$REMOTE_DIR/agen.online.key"

if [ -z "$PEM" ] || [ -z "$KEY" ]; then
  echo "用法：bash deploy/install-cert.sh <证书.pem> <私钥.key>"
  exit 1
fi
[ -f "$PEM" ] || { echo "✗ 找不到证书：$PEM"; exit 1; }
[ -f "$KEY" ] || { echo "✗ 找不到私钥：$KEY"; exit 1; }

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

echo "▶ 本地预检：证书与私钥是否配对"
c=$(openssl rsa -in "$KEY" -noout -modulus 2>/dev/null | openssl md5)
k=$(openssl x509 -in "$PEM" -noout -modulus | openssl md5)
[ "$c" = "$k" ] || { echo "✗ 证书和私钥不匹配，别传了"; exit 1; }
openssl x509 -in "$PEM" -noout -subject -dates | sed 's/^/  /'

echo "▶ 上传到 $HOST"
scp -q "$PEM" "$HOST:/tmp/agen-cert.pem"
scp -q "$KEY" "$HOST:/tmp/agen-cert.key"

echo "▶ 安装并 reload"
ssh "$HOST" 'set -e
  mkdir -p '"$REMOTE_DIR"' /etc/nginx/snippets
  install -m 600 -o root -g root /tmp/agen-cert.pem '"$REMOTE_PEM"'
  install -m 600 -o root -g root /tmp/agen-cert.key '"$REMOTE_KEY"'
  rm -f /tmp/agen-cert.pem /tmp/agen-cert.key
  nginx -t
  systemctl reload nginx'

# 站点配置：只在文件存在时同步，避免把「手工改过的线上配置」冲掉
echo "▶ 同步站点配置"
scp -q "$REPO_DIR/deploy/nginx-agen-app.conf" "$HOST:/tmp/nginx-agen-app.conf"
if [ -f "$REPO_DIR/deploy/nginx-agen-ssl.conf" ]; then
  scp -q "$REPO_DIR/deploy/nginx-agen-ssl.conf" "$HOST:/tmp/nginx-agen-ssl.conf"
fi
ssh "$HOST" 'set -e
  install -m 644 /tmp/nginx-agen-app.conf /etc/nginx/snippets/agen-app.conf
  [ -f /tmp/nginx-agen-ssl.conf ] && install -m 644 /tmp/nginx-agen-ssl.conf /etc/nginx/conf.d/agen-ssl.conf
  rm -f /tmp/nginx-agen-*.conf
  nginx -t && systemctl reload nginx'

echo "▶ 验证（SNI 取第一个域名）"
DOMAIN=$(openssl x509 -in "$PEM" -noout -ext subjectAltName | grep -o 'DNS:[^,]*' | head -1 | cut -d: -f2)
ssh "$HOST" "echo | openssl s_client -connect 127.0.0.1:443 -servername $DOMAIN 2>/dev/null \
  | grep -E 'subject=|issuer=|Verify return code'"

echo "✓ 完成：https://$DOMAIN/"
echo "  浏览器缓存了旧证书就先 Ctrl+Shift+R；HSTS 已下发，之后只走 HTTPS。"
