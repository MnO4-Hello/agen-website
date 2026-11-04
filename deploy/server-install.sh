#!/usr/bin/env bash
#
# AGenWebsite 服务器端一键安装（阿里云 ECS，root 执行）
#
# 前置：本地打进 agen-deploy.tar.gz 的包已上传并解压到 /srv/agen-website
#   mkdir -p /srv/agen-website && tar -xzf ~/agen-deploy.tar.gz -C /srv/agen-website
#   bash /srv/agen-website/deploy/server-install.sh
#
# 这个脚本只做「把机器配好 + 起服务」，不碰数据：
# apps/api/data/ 是随压缩包一起上传的，重复执行不会覆盖已有内容。
#
set -euo pipefail

APP_DIR=/srv/agen-website
APP_USER=agen
NODE_MAJOR=22
NODE_MIRROR="https://cdn.npmmirror.com/binaries/node/latest-v${NODE_MAJOR}.x"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "这个脚本要用 root 运行。"; exit 1; }
[ -f "$APP_DIR/apps/api/dist/server.js" ] || {
  echo "找不到 $APP_DIR/apps/api/dist/server.js"
  echo "请先把 agen-deploy.tar.gz 解压到 $APP_DIR 再运行本脚本。"
  exit 1
}

# ---------------------------------------------------------------- 1. 系统依赖
step "1/9 安装系统依赖"
dnf install -y nginx tar xz >/dev/null
ok "nginx $(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

# ---------------------------------------------------------------- 2. Node.js
step "2/9 Node.js ${NODE_MAJOR}"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  ok "已存在 node $(node -v)，跳过安装"
else
  cd /tmp
  VER=$(curl -fsSL "$NODE_MIRROR/SHASUMS256.txt" \
        | grep -oE "node-v${NODE_MAJOR}[0-9.]+-linux-x64\.tar\.xz" | head -1)
  [ -n "$VER" ] || { echo "拿不到 Node 版本号，检查网络或换镜像源。"; exit 1; }
  echo "  下载 $VER"
  curl -fLO "$NODE_MIRROR/$VER"
  tar -xJf "$VER" -C /usr/local --strip-components=1
  rm -f "$VER"
  ok "node $(node -v) / npm $(npm -v)"
fi

# ---------------------------------------------------------------- 3. PM2
step "3/9 npm 镜像与 PM2"
npm config set registry https://registry.npmmirror.com
command -v pm2 >/dev/null 2>&1 || npm i -g pm2 --no-audit --no-fund
ok "pm2 $(pm2 -v)"

# ---------------------------------------------------------------- 4. 运行用户
step "4/9 运行用户 ${APP_USER}"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
ok "代码目录已归属 $APP_USER（不用 root 跑网站）"

# ---------------------------------------------------------------- 5. .env
step "5/9 生成 .env"
if [ -f "$APP_DIR/.env" ]; then
  ok ".env 已存在，保留原配置不覆盖"
else
  ADMIN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > "$APP_DIR/.env" <<EOF
PORT=3000
HOST=0.0.0.0
ADMIN_SESSION_SECRET=$ADMIN_SECRET
TRUST_PROXY=1
EOF
  chmod 600 "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  # 后台**没有**环境变量账号密码：只认 users.json 里的 owner / admin 账号（见 docs/DEPLOY.md）。
  ok "已生成 .env（只含会话密钥；后台登录请用站内站长账号）"
  warn "现在是 http 访问，所以 *_COOKIE_SECURE 故意都没写——写了会登录后掉线"
  warn "别忘了先建站长账号：npm run user:create -- --username <名> --role owner"
fi

# ---------------------------------------------------------------- 6. 依赖
step "6/9 安装生产依赖"
# 前端已经构建成静态文件，服务器不需要 vite/tsc，所以只装 --omit=dev。
# 显式补 PATH：`su -` 是登录 shell，某些镜像的 /etc/profile 里没有 /usr/local/bin，
# 会报 npm: command not found。
su - "$APP_USER" -c "export PATH=/usr/local/bin:\$PATH; cd $APP_DIR && npm ci --omit=dev --no-audit --no-fund"
ok "node_modules 就绪"

# ---------------------------------------------------------------- 7. 后端
step "7/9 用 PM2 启动后端"
su - "$APP_USER" -c "export PATH=/usr/local/bin:\$PATH; cd $APP_DIR && mkdir -p logs && { pm2 describe agen-api >/dev/null 2>&1 && pm2 restart agen-api --update-env || pm2 start ecosystem.config.cjs; } && pm2 save" \
  >/dev/null
env PATH="$PATH:/usr/local/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null 2>&1 || true
systemctl enable "pm2-$APP_USER" >/dev/null 2>&1 || warn "pm2 开机自启没装上（不影响本次运行）"
sleep 3
if curl -fsS --max-time 8 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  ok "后端已响应 /api/health"
else
  warn "后端没响应，用 pm2 logs agen-api --lines 50 看原因"
fi

# ---------------------------------------------------------------- 8. Nginx
step "8/9 配置 Nginx 站点"

# 先探公网 IP：下面要把 server_name 绑到它。
# ⚠️ 阿里云镜像的 /etc/nginx/nginx.conf 里**内置**了一个 `server_name _;` 的默认站点
#    （它不在 conf.d 里，所以删 default.conf 根本删不掉）。它比 conf.d/*.conf 先加载，
#    会把我们的 `_` 抢走，日志里就是 `conflicting server name "_" ... ignored`，
#    浏览器看到的是 Nginx 欢迎页而不是本站。绑真实 IP 才不会被抢。
IP=$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || true)
[ -n "${IP:-}" ] || IP=$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null || true)
[ -n "${IP:-}" ] || IP=$(curl -s --max-time 5 https://ifconfig.me 2>/dev/null || true)

# 站点内容（root / 缓存 / 反代 / 兜底路由）单独放 snippet：
# 80 和 443 两个 server 都 include 它，切 HTTPS 时不用维护两份配置。
install -d -m 755 /etc/nginx/snippets
install -m 644 "$APP_DIR/deploy/nginx-agen-app.conf" /etc/nginx/snippets/agen-app.conf

install -m 644 "$APP_DIR/deploy/nginx-agen.conf" /etc/nginx/conf.d/agen.conf
rm -f /etc/nginx/conf.d/default.conf
if [ -n "${IP:-}" ]; then
  sed -i "s#^    server_name _;#    server_name ${IP};#" /etc/nginx/conf.d/agen.conf
  ok "server_name 已绑定 ${IP}（避开系统内置默认站点）"
else
  warn "没探测到公网 IP，server_name 保持 _（可能被系统默认站点抢占，见文档排错表）"
fi

# HTTPS 只在证书就位后才启用：没有 /etc/nginx/ssl/agen.online.pem 就直接不装
# 443 那份配置（否则 nginx -t 会因为找不到证书而失败，整站起不来）。
# 装证书：bash deploy/install-cert.sh <证书.pem> <私钥.key>
if [ -f /etc/nginx/ssl/agen.online.pem ] && [ -f /etc/nginx/ssl/agen.online.key ]; then
  install -m 644 "$APP_DIR/deploy/nginx-agen-ssl.conf" /etc/nginx/conf.d/agen-ssl.conf
  ok "检测到证书，已启用 443（域名 301 到 HTTPS）"
else
  rm -f /etc/nginx/conf.d/agen-ssl.conf
  warn "没有证书，只监听 80；要上 HTTPS 见 docs/DEPLOY.md 附录 B"
fi

nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx 2>/dev/null || systemctl start nginx
ok "agen 站点已加载（静态目录 apps/web/dist + /api 反代 127.0.0.1:3000）"

# ---------------------------------------------------------------- 9. 收尾
step "9/9 SELinux 与防火墙"
if [ "$(getenforce 2>/dev/null || echo Disabled)" = "Enforcing" ]; then
  setsebool -P httpd_can_network_connect on
  chcon -R -t httpd_sys_content_t "$APP_DIR/apps/web/dist" 2>/dev/null || true
  ok "SELinux 已允许 Nginx 反代 3000 端口"
else
  ok "SELinux 未开启，跳过"
fi
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http >/dev/null
  firewall-cmd --permanent --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
  ok "firewalld 已放行 80/443"
else
  ok "firewalld 未运行，跳过"
fi

IP=$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || true)
[ -n "${IP:-}" ] || IP=$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null || true)
[ -n "${IP:-}" ] || IP=$(curl -s --max-time 5 https://ifconfig.me 2>/dev/null || true)

printf '\n\033[1;32m================ 部署完成 ================\033[0m\n'
echo "  站点：     http://${IP:-<你的公网IP>}/"
echo "  管理后台： http://${IP:-<你的公网IP>}/admin.html"
echo
if [ -f /root/agen-credentials.txt ]; then
  echo "  ⚠️ 发现旧的 /root/agen-credentials.txt（早期的 ADMIN_USER/ADMIN_PASSWORD），"
  echo "     那对凭据已失效，可以删掉：rm -f /root/agen-credentials.txt"
  echo
fi
echo "  后台登录用站内站长账号（users.json 里的 owner），不再有环境变量账号密码。"
echo "  打不开的话，第一件事是去阿里云控制台放行安全组的 80 端口。"
echo "  看日志：pm2 logs agen-api --lines 50"
printf '\033[1;32m==========================================\033[0m\n'
