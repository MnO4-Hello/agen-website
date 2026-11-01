# 部署到阿里云 ECS

> 目标形态：**一台服务器、暂时用公网 IP、Nginx 当前门、Fastify 在后面**。
> 系统：Alibaba Cloud Linux 3 / CentOS 系（`dnf`）。
> 暂不做：域名 + 备案 + HTTPS（文末有补齐方法）。

---

## 0. 先看清这套东西长什么样

```
                    ┌──────────────────────── 一台 ECS（公网 IP:80）────────────────────────┐
   浏览器 ────80───▶ │  Nginx                                                              │
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
| 443 | TCP | 0.0.0.0/0 | 以后上 HTTPS（可以先加） |

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

它会依次打印 1/9 到 9/9 的进度，最后输出站点地址和管理员账号密码
（密码同时留在 `/root/agen-credentials.txt`）。

跑完直接访问 `http://服务器IP/`。

### 脚本之后还可以手工核对这几处

| 项 | 检查命令 | 期望 |
| --- | --- | --- |
| 后端活着 | `curl -s http://127.0.0.1:3000/api/health` | 返回 JSON |
| 进程单实例 | `su - agen -c "pm2 list"` | 只有 1 个 `agen-api`，状态 online |
| 开机自启 | `systemctl is-enabled pm2-agen` | `enabled` |
| Nginx 配置 | `nginx -t` | test is successful |
| 站点名已绑定 | `grep server_name /etc/nginx/conf.d/agen.conf` | 是公网 IP，不是 `_`（见下方「默认站点抢占」） |
| 配置内容 | `cat /srv/agen-website/.env` | 有 `TRUST_PROXY=1`，**没有** `*_COOKIE_SECURE` |

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

**② 管理员密码。** 脚本随机生成，存在 `/root/agen-credentials.txt`。想换成自己的：

```bash
nano /srv/agen-website/.env      # 改 ADMIN_PASSWORD
su - agen -c "pm2 restart agen-api"
```

---

## 5. 验收清单

按顺序点一遍，每一条都对应一个真实踩过的坑：

| # | 操作 | 期望 | 失败说明 |
| --- | --- | --- | --- |
| 1 | `http://服务器IP/` | 首屏正常，字体/头像都在 | 白屏 → 看 Nginx error.log |
| 2 | 滚到 WORK 段 | 作品墙有卡片 | 空 → 数据没进包 |
| 3 | `http://服务器IP/api/health` | JSON | 502 → 后端没起 或 SELinux |
| 4 | `http://服务器IP/admin.html` | 登录框出现 | 404 → `apps/web/dist/admin.html` 缺失 |
| 5 | 用管理员账号登录 | 进后台 | 登录后刷新掉线 → `.env` 里有 `Secure` |
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
| 登录成功、刷新回登录页 | cookie 带了 `Secure` 却在 http 上 | 注释掉 `*_COOKIE_SECURE` 后重启 |
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

## 附录 B：以后要加域名 + HTTPS

1. 域名解析 A 记录指向公网 IP。
2. **大陆服务器必须先完成 ICP 备案**，否则 80/443 上的域名访问会被云厂商拦截
   （用 IP 直接访问不受此限制，所以现在能跑）。
3. 备案通过后，把 `/etc/nginx/conf.d/agen.conf` 里的 `server_name _;` 改成你的域名，
   再加一个 443 的 server 块（证书可用 `certbot --nginx` 或阿里云免费证书）。
4. 此时才把 `.env` 里补上：

```ini
ADMIN_COOKIE_SECURE=1
USER_COOKIE_SECURE=1
```

改完 `pm2 restart agen-api`。**顺序不能反**——先开 Secure 再挂证书，会直接登不进去。

## 附录 C：备案形态（`SITE_MODE`）

### 为什么要有这个开关

以**个人（自然人）**名义做 ICP 备案时，站内不能有「用户发帖 / 回复 / 评论 / 留言」这类
交互式栏目——管局初审与后续的常态化核查都会点进来看实际内容。而这个仓库默认带着博客、
留言板、注册登录和公开主页，等于一上线就踩线。

所以功能层做了个开关：**同一份代码、两种形态**。真源是后端环境变量 `SITE_MODE`
（`apps/api/src/site/mode.ts`），前端启动时问 `GET /api/site/config` 拿到同一份配置，
据此决定画几项导航、注册哪些路由。

| 模式 | 前台 | 接口 | 什么时候用 |
| --- | --- | --- | --- |
| `full`（默认） | 五项导航 + 右上角登录 | 全开 | 平时开发；不备案的部署（境外 / 仅 IP 访问） |
| `display` | 首页 / 作品 / 关于 三项，没有登录入口 | 博客、留言、账号、公开主页一律 404 | 个人备案通过后，作为展示站上线 |
| `maintenance` | 只有一个「备案中」页 | 除 `/api/site/config`、`/api/health` 外全 503 | 备案审核期间整站关闭 |

切换只改 `.env` 一行，然后 `pm2 restart agen-api`。**前端静态产物不用重新构建**——
这就是把开关放在后端的原因（备案过审是「想立刻生效」的事，不该逼你重新打包上传 dist）。

### 备案期间的操作顺序

```bash
# 1. 提交审核前，先整站关掉（审核员打开就是「备案中」）
su - agen -c "cd /srv/agen-website && sed -i 's/^# SITE_MODE=.*/SITE_MODE=maintenance/' .env && pm2 restart agen-api"

# 2. 确认
curl -s https://你的域名/api/site/config     # {"mode":"maintenance",...}
```

3. 备案通过后改成展示形态：

```bash
su - agen -c "cd /srv/agen-website && sed -i 's/^SITE_MODE=.*/SITE_MODE=display/' .env && pm2 restart agen-api"
```

4. 在页脚挂备案号（`ICP备XXXXXXXX号-1`，链接到 `https://beian.miit.gov.cn/`）——
   现在的页脚胶囊里还没有，要在 `apps/web/src/content/cta.ts` 里补一条。
5. 30 日内做**公安联网备案**（全国互联网安全管理服务平台）。

### ⚠️ `display` 不是「骗过审核」

`display` 只是让站的形态**符合个人主体的申报内容**。个人备案的网站本身就不允许开
社区，所以：

- 备案通过后如果又把 `SITE_MODE` 改回 `full`，被抽查到一样会被**注销备案 + 关站**，
  这不是「过审了就可以随便开」。
- 真想把社区开起来，正确路径是**换成企业 / 个体工商户主体**重新备案（见对话里的
  B 方案），而不是偷偷改回去。
- `full` 只在两种情况合规：服务器不在境内（不需要 ICP 备案），或者你确实拿到了
  允许做交互式服务的单位备案。

### 想在 Nginx 上再挡一道（可选）

`SITE_MODE=maintenance` 已经让接口全 503、前端渲染提示页。如果想连静态资源都不发出去
（更彻底，也省流量），在 `deploy/nginx-agen.conf` 的 `server` 块里临时加：

```nginx
    # 备案期间整站关闭。**过审后记得删掉这三行**，否则一直是 503。
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
```

`beian.html` 自己放一个静态提示页进 `apps/web/dist` 即可（前端那份 `maintenance` 页
需要先加载 JS 才出来，Nginx 这层则是零 JS 的兜底）。两道门都留着更保险：反向代理的
配置万一没同步，后端那道还在。

