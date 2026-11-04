# 部署到阿里云 ECS

> 目标形态：**一台服务器、Nginx 当前门、Fastify 在后面**。
> 系统：Alibaba Cloud Linux 3 / CentOS 系（`dnf`）。
> **HTTPS 已上线（2026-11-04）**：`阿根.online` 走阿里云 DV 证书，域名一律 301 到 443。
> 备案形态见附录 C。

---

## 0. 先看清这套东西长什么样

```
                    ┌────────────── 一台 ECS（:80 明文兜底 / :443 域名 HTTPS）──────────────┐
   浏览器 ──443───▶ │  Nginx                                                              │
   （只认一个源）     │   ├─ /            → /srv/agen-website/apps/web/dist  （静态文件）    │
                    │   └─ /api/*       → 127.0.0.1:3000  （反向代理）                     │
                    │                          │                                          │
                    │                          ▼                                          │
                    │              PM2 守护的 node dist/server.js（Fastify）               │
                    │                          │                                          │
                    │                          ▼                                          │
                    │              apps/api/data/  ← 账号、作品、博客、留言、上传的图片     │
                    └─────────────────────────────────────────────────────────────────────┘
```

四条必须记住的事实：

1. 前端是**纯静态**产物，不需要 Node 去跑；真正常驻的只有后端一个进程。
2. 所有业务数据（含图片）都在 `apps/api/data/` 这个**被 gitignore 的目录**里。
3. 后端**只能单实例**。数据层是 JSON 文件 + 进程内缓存，开两个进程会互相覆盖写。
4. 仓库现在是完整的（2026-11-01 把作品 / 账号 / 博客 / 留言 / 管理后台一并提交并推送），
   `git clone` 能拿到整套代码；但这台机器到 GitHub 的连通性很差，**日常更新走
   `npm run deploy`（推送即部署），不要指望在服务器上 `git pull`**，见附录 A。

下文命令里的 `服务器IP` 替换成你的公网 IP。

---

## 1. 开安全组（最容易漏的一步）

阿里云控制台 → 云服务器 ECS → 实例 → 点进实例 → **安全组** → 配置规则 → 入方向 → 手动添加：

| 端口 | 协议 | 授权对象 | 用途 |
| --- | --- | --- | --- |
| 22 | TCP | 0.0.0.0/0 | SSH 登录（一般已开） |
| 80 | TCP | 0.0.0.0/0 | 网站 |
| 443 | TCP | 0.0.0.0/0 | HTTPS（已在用） |

> 阿里云的安全组和服务器内部的防火墙是**两道门**，两道都要开。安全组不放行，服务器里配得
> 再对，浏览器也是一直转圈到超时。

---

## 2. 打开网页终端并体检

不需要装 SSH 客户端：控制台实例页右上角 **远程连接** → **Workbench 远程连接** → 立即登录，
就是 root 的网页终端。下面的命令都粘在这里。

```bash
cat /etc/os-release | head -3     # 确认是 Alibaba Cloud Linux 3
getenforce                        # 期望 Disabled / Permissive
ss -lntp | grep -E ':80|:3000'    # 期望无输出（端口没被占）
free -h                           # 顺手看内存
```

如果 80 端口已被占用（装过宝塔之类），先 `systemctl stop nginx httpd` 或停掉占用进程。

---

## 3. 本地打包 → 上传

**在你自己的 Windows 电脑上**，仓库根目录（Git Bash）：

```bash
npm run build        # 先确保 dist 是最新的
tar -czf agen-deploy.tar.gz \
  package.json package-lock.json ecosystem.config.cjs \
  apps/web/package.json apps/web/tsconfig.json apps/web/dist \
  apps/api/package.json apps/api/tsconfig.json apps/api/dist \
  apps/api/data deploy
```

这个包约 12MB，**同时带上了**：前端产物、后端产物、全部数据（账号/作品/博客/留言/图片）。

然后在网页终端的工具栏点 **上传文件**，选 `agen-deploy.tar.gz`（默认落到 `/root/`），
上传完执行：

```bash
mkdir -p /srv/agen-website
tar -xzf /root/agen-deploy.tar.gz -C /srv/agen-website
ls /srv/agen-website/apps/web/dist      # 能看到 index.html / admin.html / assets 就对了
```

> 为什么不在服务器上构建：服务器没装 vite/tsc，而且 1C2G 的机器跑 Vite 容易 OOM。
> 本地构建好再传产物，又快又稳。

---

## 4. 一键安装

仓库里带了一个脚本，把「装 Node / 建用户 / 写 .env / 装依赖 / 起 PM2 / 配 Nginx /
SELinux / 防火墙」全串好了：

```bash
bash /srv/agen-website/deploy/server-install.sh
```

它会依次打印 1/9 到 9/9 的进度，最后输出站点地址。

跑完直接访问 `http://服务器IP/`。

### 脚本之后还可以手工核对这几处

| 项 | 检查命令 | 期望 |
| --- | --- | --- |
| 后端活着 | `curl -s http://127.0.0.1:3000/api/health` | 返回 JSON |
| 进程单实例 | `su - agen -c "pm2 list"` | 只有 1 个 `agen-api`，状态 online |
| 开机自启 | `systemctl is-enabled pm2-agen` | `enabled` |
| Nginx 配置 | `nginx -t` | test is successful |
| 站点名已绑定 | `grep server_name /etc/nginx/conf.d/agen.conf` | 是公网 IP，不是 `_`（见下方「默认站点抢占」） |
| 配置内容 | `cat /srv/agen-website/.env` | 有 `TRUST_PROXY=1`，**且**有 `*_COOKIE_SECURE=1`（HTTPS 已开） |

### 脚本没有代劳的两件事

**① 首次站长账号。** 数据包里已经带了 `users.json`，你原来的 owner 账号直接能用，
**不需要**再建号。只有全新开站才需要：

```bash
cd /srv/agen-website
su - agen -c "cd /srv/agen-website && npm run user:create -- \
  --username 你的用户名 --nickname 昵称 --email 你的邮箱 --role owner"
```

> `npm run user:create` 用的是 tsx（devDependency），而服务器只装了生产依赖。
> 真要用这条命令，先 `su - agen -c "cd /srv/agen-website && npm i -D tsx"`，
> 或者干脆在本地建好账号再把 `apps/api/data/users.json` 传上去。

**② 后台登录用哪个号。** 只有站内账号能登后台（`role` 为 `owner` / `admin`），也就是上面
① 建的那个号。脚本不再生成 `ADMIN_USER` / `ADMIN_PASSWORD`——那套环境变量身份在
`users.json` 里查不到、也删不掉，2026-11-04 已按要求整体移除。`.env` 里现在只需要
`ADMIN_SESSION_SECRET`；**换掉它 = 让所有后台会话立刻失效**：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 生成新密钥
nano /srv/agen-website/.env      # 改 ADMIN_SESSION_SECRET
su - agen -c "pm2 restart agen-api --update-env"
```

---

## 5. 验收清单

按顺序点一遍，每一条都对应一个真实踩过的坑：

| # | 操作 | 期望 | 失败说明 |
| --- | --- | --- | --- |
| 1 | `https://阿根.online/` | 首屏正常，地址栏是锁 | 白屏 → 看 Nginx error.log；证书告警 → 附录 B |
| 1b | `http://阿根.online/` | 301 跳到 https | 没跳 → `agen-ssl.conf` 没加载 |
| 2 | 滚到 WORK 段 | 作品墙有卡片 | 空 → 数据没进包 |
| 3 | `http://服务器IP/api/health` | JSON | 502 → 后端没起 或 SELinux |
| 4 | `http://服务器IP/admin.html` | 登录框出现 | 404 → `apps/web/dist/admin.html` 缺失 |
| 5 | 用管理员账号登录（走 `https://`） | 进后台 | 登录后刷新掉线 → `.env` 里 Secure 开着却是明文访问，换 https |
| 6 | 后台「控制台」 | 日志**逐行**实时滚动 | 卡住 → Nginx 的 SSE 段没生效 |
| 7 | 后台「作品」传一张图 | 上传成功、详情页能看到 | 413 → `client_max_body_size` 没生效 |
| 8 | 前台注册 → 留言 | 留言出现在留言板 | 429 → 限流；确认 `TRUST_PROXY=1` |
| 9 | `reboot` 后重访 | 网站自己就活了 | 死站 → `systemctl is-enabled pm2-agen` |

---

## 6. 日常运维

### 改了代码怎么更新

**日常更新只用一条命令**（正文见附录 A）：

```bash
npm run deploy        # push 到服务器 → 装依赖（必要时）→ 构建 → 重启 → 自检
```

只有在这台机器还没配好 git（比如刚按本文档重建过）时，才用下面这套「打包上传」的
老办法过渡：

```bash
# 本地
npm run build
tar -czf agen-deploy.tar.gz ...       # 同第 3 步，但这次**不要**带上 apps/api/data
# 上传后
tar -xzf /root/agen-deploy.tar.gz -C /srv/agen-website
su - agen -c "cd /srv/agen-website && npm ci --omit=dev && pm2 restart agen-api"
```

前端是静态文件，`dist` 换掉就生效，不用 reload Nginx（HTML 没做长缓存，访客不会拿到旧页面）。
**千万不要把 `apps/api/data` 再解压一遍**，那会用旧数据覆盖掉线上新产生的留言和账号。

### 看日志

```bash
su - agen -c "pm2 logs agen-api --lines 100"     # 后台「控制台」看的是同一份
su - agen -c "pm2 status"
tail -f /var/log/nginx/agen.error.log
```

### 备份数据（务必做）

`apps/api/data/` 里是全站内容和账号，**没有它就等于没有网站**：

```bash
mkdir -p /srv/backup
crontab -e -u agen     # 写入下面一行（每天 4:10）
```

```cron
10 4 * * * tar -czf /srv/backup/agen-$(date +\%F).tar.gz -C /srv/agen-website/apps/api data && find /srv/backup -name 'agen-*.tar.gz' -mtime +14 -delete
```

---

## 7. 排错对照表

| 症状 | 最可能的原因 | 处理 |
| --- | --- | --- |
| 浏览器显示 **Nginx 欢迎页**（而不是本站），日志有 `conflicting server name "_" ... ignored` | 阿里云镜像在 `/etc/nginx/nginx.conf` 里**内置**了一个 `server_name _;` 的默认站点，比 `conf.d/*.conf` 先加载，把 `_` 抢走了（删 `conf.d/default.conf` 没用） | `sed -i 's#^    server_name _;#    server_name 公网IP;#' /etc/nginx/conf.d/agen.conf && nginx -t && systemctl reload nginx` |
| 浏览器一直转圈，最后超时 | 安全组没放 80 | 第 1 步 |
| 502 Bad Gateway | 后端没起 / SELinux / 端口不一致 | `pm2 status`、`curl 127.0.0.1:3000/api/health`、`setsebool -P httpd_can_network_connect on` |
| 页面白屏，控制台 404 `/assets/...` | Nginx `root` 路径不对 | `ls /srv/agen-website/apps/web/dist/assets` 并核对配置 |
| 登录成功、刷新回登录页 | cookie 带了 `Secure` 却在 http 上 | 换 `https://` 访问；纯 IP 明文调试才需要临时注释掉 `*_COOKIE_SECURE` |
| 上传图片 413 | Nginx `client_max_body_size` | 改 30m 并 reload |
| 留言/回复提示「太频繁」 | 限流把所有人当成一个 IP | `.env` 加 `TRUST_PROXY=1` 并重启 |
| 后台控制台日志不动 | SSE 被 Nginx 缓冲 | 确认 `location = /api/admin/console/stream` 生效 |
| 数据「刚发的刷新就没了」 | 跑了多个后端实例 | 只留一个 `agen-api` |
| 启动日志报 `ENOENT .env` | 工作目录不对 | PM2 的 `cwd` 必须是 `/srv/agen-website` |

---

## 附录 A：日常更新（推送即部署）

`/srv/agen-website` 现在是一个正常的 git 检出（`origin` = GitHub），并额外配了
`receive.denyCurrentBranch=updateInstead` —— 本地 `git push` 会把新提交**直接推进
线上工作区**，所以更新只有一条命令：

```bash
npm run deploy
# = git push deploy main && ssh agen-server bash /srv/agen-website/deploy/remote-deploy.sh
```

`deploy/remote-deploy.sh` 依次做：比对 `package-lock.json` 哈希（变了才 `npm ci`，
没变跳过，省掉最慢也最危险的步骤）→ `npm run build` → `pm2 restart agen-api --update-env`
→ `pm2 save` → 健康自检（起不来会直接报错并打印 `pm2 list`）。

**为什么不在这台机器上 `git pull`**：实测 ECS 到 `github.com:443` 三次握手只成功一次，
HTTPS 请求经常 10s 超时，`git pull` 会随机卡死；而 `git push` 的成败本地立刻可见。
`origin` 仍然留着，网络好的时候 `git pull origin main` 也能用，只是别指望它。

**回滚**：

```bash
ssh agen-server 'cd /srv/agen-website && git reset --hard <旧提交>'
ssh agen-server bash /srv/agen-website/deploy/remote-deploy.sh
```

重建机器时才需要的一次性准备（当前这台已经配好）：

```bash
# 服务器侧
dnf -y install git
su - agen -c 'cd /srv/agen-website && git init -b main \
  && git remote add origin https://github.com/MnO4-Hello/agen-website.git \
  && git fetch origin main && git reset --hard origin/main \
  && git config receive.denyCurrentBranch updateInstead'

# 本地侧（~/.ssh/config 里 agen-server = User agen + 部署密钥）
git remote add deploy ssh://agen-server/srv/agen-website
```

`agen` 用户的 `~/.ssh/authorized_keys` 里要放同一把公钥（push 以 agen 身份落盘，
`npm ci` / `npm run build` 才不会因为文件属主是 root 而失败）。

`deploy/` 里的另外两份配置（`nginx-agen.conf`、`server-install.sh`）是首次装机用的。

## 附录 B：HTTPS（已启用，2026-11-04）

### 现在的状态

| 项 | 值 |
| --- | --- |
| 域名 | `阿根.online` / `www.阿根.online`（配置里用 punycode `xn--xxv873h.online`） |
| 证书 | 阿里云免费 DV（DigiCert *Encryption Everywhere DV TLS CA - G2*），**3 个月一签** |
| 覆盖 | 裸域 + www 都在 SAN 里，共用一个 pem |
| 存放 | `/etc/nginx/ssl/agen.online.pem`（600，root）/ `agen.online.key`（600，root） |
| 有效期 | 抓帧时是 2026-11-04 → 2027-02-01 |
| 协议 | TLS 1.2 / 1.3，HTTP/2，HSTS 一年 |

> 📌 **ICP 备案**：这台机器在境内，域名对外提供 Web 服务按规定需要备案；没备案时云厂商
> 可能在后续核查中拦截 80/443 上的域名访问（IP 直连不受影响）。以个人主体申报时的
> 站点形态（`display`，不能带社区/留言/注册）见附录 C。

**配置怎么分工**（三份，改一边就够）：

```
/etc/nginx/snippets/agen-app.conf   ← root / 缓存 / 反代 / try_files（80 与 443 共用）
/etc/nginx/conf.d/agen.conf         ← 80，server_name 绑公网 IP（IP 明文兜底）
/etc/nginx/conf.d/agen-ssl.conf     ← 80 域名 301 → 443；443 真正站点
```

> 为什么留 80 的 IP 入口：证书不含 IP，`https://IP` 浏览器必告警；留一条明文通道，
> 证书出问题时还能 `http://IP/admin.html` 进后台救场。

### 换证书 / 续期（3 个月一次）

阿里云控制台 → 数字证书管理服务 → 下载 **Nginx** 格式 → 本地解压得到 `.pem` + `.key`：

```bash
bash deploy/install-cert.sh ~/Downloads/www.xn--xxv873h.online.pem \
                            ~/Downloads/www.xn--xxv873h.online.key
```

脚本会：校验配对 → 上传到 `/etc/nginx/ssl/`（600/root）→ 同步 snippet 与 443 配置
→ `nginx -t` → reload → 用 `openssl s_client` 验链。**换证书不用重启后端。**

查剩余天数（建议加个日历提醒，剩 15 天就换）：

```bash
ssh agen-root 'openssl x509 -in /etc/nginx/ssl/agen.online.pem -noout -subject -enddate'
```

### 排错

| 症状 | 原因 / 处理 |
| --- | --- |
| `nginx -t` 报 `cannot load certificate` | pem/key 没传上去或路径不对；重跑 `install-cert.sh` |
| 浏览器 `NET::ERR_CERT_DATE_INVALID` | 证书过期；续期后 reload |
| `https://域名` 打开是 Nginx 欢迎页 | `server_name` 没匹配上：确认是 punycode，且 `nginx -T \| grep server_name` |
| 443 连不上（超时） | 安全组没放 443（第 1 步），或 `ss -lntp \| grep :443` 没监听 |
| 改了配置没生效 | 忘了 `systemctl reload nginx` |
| 想临时退回纯 HTTP | `rm /etc/nginx/conf.d/agen-ssl.conf && systemctl reload nginx`（HSTS 已下发的浏览器仍会强跳，需清站点数据） |

### cookie 的 Secure（已开启，2026-11-04）

`.env` 里已经写死：

```ini
# /srv/agen-website/.env
ADMIN_COOKIE_SECURE=1
USER_COOKIE_SECURE=1
```

顺序不能反——**先有 HTTPS 再开 Secure**，否则 cookie 在明文连接上直接被浏览器丢掉。

实测（`curl` 走 443 登录）：

```
set-cookie: agen_admin=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure
带 cookie 再取 /api/admin/session → {"authenticated":true}
同一个 cookie 拿去打 http://IP/api/admin/session → {"authenticated":false}  ← 明文拿不到会话
POST /api/admin/logout → Max-Age=0; Secure（能正常清掉）
```

> ⚠️ 副作用：`http://121.196.175.54/admin.html` 现在**登录不进去**（Secure cookie 不发明文）。
> 这是预期行为，后台一律走域名。
>
> 真要用 IP 明文救急：把这两行改成 `0`（或删掉）→ `su - agen -c "pm2 restart agen-api"`。

`display` 模式下页脚要挂 ICP 备案号，见附录 C 第 4 条。

## 附录 C：备案形态（站点模式开关）

### 为什么要有这个开关

以**个人（自然人）**名义做 ICP 备案时，站内不能有「用户发帖 / 回复 / 评论 / 留言」这类
交互式栏目——管局初审与后续的常态化核查都会点进来看实际内容。而这个仓库默认带着博客、
留言板、注册登录和公开主页，等于一上线就踩线。

所以功能层做了个开关：**同一份代码、三种形态**。

| 模式 | 前台 | 接口 | 什么时候用 |
| --- | --- | --- | --- |
| `full`（默认） | 五项导航 + 右上角登录 | 全开 | 平时开发；不备案的部署（境外 / 仅 IP 访问） |
| `display` | 首页 / 作品 / 关于 三项，没有登录入口 | 博客、留言、账号、公开主页一律 404 | 个人备案通过后，作为展示站上线 |
| `maintenance` | 只有一个「备案中」页 | 除 `/api/site/config`、`/api/health`、`/api/admin/*` 外全 503 | 备案审核期间整站关闭 |

### 怎么切：在后台点，不用重启

登录 `/admin.html` → 左侧「**设置**」→ 选一档 → 确认。**站长专属**（管理员连入口都看不到）。

- 写盘位置：`apps/api/data/site-mode.json`（已在 `.gitignore` 里，不进仓库）。
- **接口立刻生效，不用重启进程**；已经打开的前台页面需要刷新才变。
- 前端静态产物完全不用重新构建——配置是运行时 `GET /api/site/config` 拉的。

### `.env` 里的 `SITE_MODE` 现在只是初始值

真源是那个 JSON 文件。判定顺序：

| `data/site-mode.json` | 生效 |
| --- | --- |
| 存在且合法 | **文件里的值**（后台切过） |
| 不存在 | `.env` 的 `SITE_MODE`，没写就是 `full` |
| 存在但读不出来 | **`display`**（fail-closed），后台会显示「读取失败，已回退」 |

所以：**在后台切过之后，再改 `.env` 不会生效。** 想让 `.env` 重新说了算，
删掉 `apps/api/data/site-mode.json` 再重启。反过来，手动编辑这个 JSON 也要重启才生效
（进程只在启动时读一次）。

`maintenance` 下 `/api/admin/*` 是**故意放行**的：整站关闭时后台必须还能进去，否则只能
上服务器改文件才能把站救回来。

### 备案期间的操作顺序

1. **提交审核前**，在后台切到「备案中」（要确认两次）。
2. 确认：

   ```bash
   curl -s https://你的域名/api/site/config     # {"mode":"maintenance",...}
   curl -s -o /dev/null -w '%{http_code}\n' https://你的域名/   # 503
   ```

3. **备案通过后**，在后台切到「展示站」——个人主体的申报形态就是这个，不要开回 `full`。
4. 在页脚挂备案号（`ICP备XXXXXXXX号-1`，链接到 `https://beian.miit.gov.cn/`）——
   现在的页脚胶囊里还没有，要在 `apps/web/src/content/cta.ts` 里补一条。
5. 30 日内做**公安联网备案**（全国互联网安全管理服务平台）。

### 后台进不去时怎么救（应急通道）

按可能性排序，前两条都不用重新构建前端：

```bash
# ① 只想改模式：直接改 JSON，然后重启
su - agen -c "cd /srv/agen-website && \
  printf '{\"version\":1,\"mode\":\"display\",\"updatedAt\":\"\",\"updatedBy\":\"manual\"}\n' \
  > apps/api/data/site-mode.json && pm2 restart agen-api"

# ② 让 .env 重新说了算：删掉覆盖文件
rm -f /srv/agen-website/apps/api/data/site-mode.json
su - agen -c "cd /srv/agen-website && pm2 restart agen-api"

# ③ 后台登录 503：说明 .env 里的 ADMIN_SESSION_SECRET 没配
grep -c '^ADMIN_SESSION_SECRET=' /srv/agen-website/.env     # 应该是 1
```

改完之后用 `curl -s http://127.0.0.1:3000/api/site/config` 确认。

### ⚠️ `display` 不是「骗过审核」

`display` 只是让站的形态**符合个人主体的申报内容**。个人备案的网站本身就不允许开
社区，所以：

- 备案通过后如果又把模式开回 `full`，被抽查到一样会被**注销备案 + 关站**，
  这不是「过审了就可以随便开」。
- 真想把社区开起来，正确路径是**换成企业 / 个体工商户主体**重新备案（见对话里的
  B 方案），而不是偷偷改回去。
- `full` 只在两种情况合规：服务器不在境内（不需要 ICP 备案），或者你确实拿到了
  允许做交互式服务的单位备案。


### 想在 Nginx 上再挡一道（可选，**会把自己锁在门外**）

现在的「备案中」已经让接口全 503、前端渲染提示页。如果想连静态资源都不发出去
（更彻底，也省流量），在 `deploy/nginx-agen.conf` 的 `server` 块里临时加：

```nginx
    # 备案期间整站关闭。**过审后记得删掉**，否则一直是 503。
    #
    # ⚠️ 不要写成 server 级的 `return 503;`：`error_page` 的内部跳转会重新走一遍
    # server rewrite，又撞上那条 return，转十次之后变成 500。必须用 `location /`
    # 把「兜底返回 503」限制在页面路径上，让 `= /beian.html` 这个精确匹配能逃出去。
    location / {
        return 503;
    }
    error_page 503 /beian.html;

    location = /beian.html {
        root /srv/agen-website/apps/web/dist;
        internal;
    }

    # ⚠️ 必须留着：后台页面是静态文件，会被上面那条 `location /` 一起挡掉。
    # 挡掉之后网页后台就进不去了，只能上服务器改 JSON 才能把站救回来。
    # 精确匹配的优先级高于前缀匹配，所以这条不用调顺序。
    location = /admin.html {
        try_files $uri =404;
    }
```

- `/api/admin/*` 走的是已有的 `location /api/`（前缀更长，优先级高于 `location /`），
  所以**不用**额外放行——后端那边本来也放行了 `/api/admin`。
- `/assets/*` 也有独立的 location，同样不受影响。
- 唯一会被误伤的就是 `/admin.html` 本身，所以上面那条必须加。
- `beian.html` 自己放一个静态提示页进 `apps/web/dist` 即可（前端那份 `maintenance` 页
  需要先加载 JS 才出来，Nginx 这层则是零 JS 的兜底）。两道门都留着更保险：反向代理的
  配置万一没同步，后端那道还在。


