# 开发笔记 · AGenWebsite

> 这份文档是 [README](../README.md) 的开发笔记：目录结构、各板块的动画时间线、
> 路由与账号体系、后台接口约定、以及一批「为什么这么做」的踩坑记录。
> 只想把站点跑起来的话看 README 就够了；要改代码再往下读。

个人网站的基础框架（monorepo）：前端 Vite + TypeScript，后端 Node.js + Fastify，
并通过 `/api` 代理连起来。前端首页是 3D 字标 + 枫叶粒子场景，后面接“我是谁？”板块
——钉住画面后自动播放开场动画（打字机标题、粒子拼出头像、问候语炸开震散正文）；
再接“我会什么？”板块——沿用同一层浅绿底，标题从上方落下，左侧先由线条画出一张牌
再散成五张扇形卡牌，右侧线框里粒子团汇聚成牌面。

导航栏的五个板块现在都是**真实页面**（哈希路由）：主页是上面那条长长的滚动叙事，
作品 / 博客 / 留言 / 关于我**已经建好骨架但还没填内容**（占位页）。另有一个
**不在任何导航里的管理后台**：地址 `/admin.html`，账号密码登录，登录后左侧是功能卡、
右侧是内容——目前有「控制台」（实时看后端进程输出）、「文件管理」（白名单目录的增删改）
与「作品」（列表 / 编辑，模板与开发者两种模式）。

Windows 与 Linux 均可运行。

## 目录结构

```
AGenWebsite/
├─ apps/
│  ├─ web/              # 前端：Vite + TypeScript
│  │  ├─ index.html     # 主站入口（五个标签页都在这一个入口里）
│  │  ├─ admin.html     # 隐藏的管理后台入口（独立入口，公开页面里没有链接）
│  │  ├─ vite.config.ts # 含 /api 开发 / 预览代理，以及 index + admin 两个构建入口
│  │  ├─ public/        # 静态资源（头像 PNG，按 512 / 1024 两种尺寸发布）
│  │  └─ src/
│  │     ├─ main.ts        # 入口：装配平滑滚动、导航栏、路由与各页面视图
│  │     ├─ router.ts      # 极小的哈希路由（挂载 / 卸载页面视图）
│  │     ├─ styles.css     # 主题变量与全部样式
│  │     ├─ admin/         # 管理后台（独立入口，自带 admin.css，不引 styles.css）
│  │     │                  #   main.ts 登录态 → 外壳；views/{shell,console,files,login}.ts
│  │     │                  #   api.ts 所有 /api/admin 请求；ui.ts 建节点 / 格式化 / 图标
│  │     ├─ components/    # UI 组件（navbar.ts）
│  │     ├─ content/       # 文案（profile.ts 自我介绍；skills.ts 卡牌；pages.ts 标签页）
│  │     ├─ pages/         # 页面模块（home.ts 首屏；home-view.ts 首页装配；
│  │     │                  #   page-shell.ts 占位页外壳；works/blog/message/about.ts）
│  │     ├─ sections/      # 滚动板块（identity.ts 我是谁？；skills.ts 我会什么？）
│  │     └─ scene/         # 主页的各个动画场景
│  │        ├─ leaf-shape.ts      # 枫叶轮廓生成与配色
│  │        ├─ leaf-physics.ts    # 单片枫叶的重力、碰撞与静止
│  │        ├─ leaf-field.ts      # 画布、指针风、碰撞体收集与渲染
│  │        ├─ hero-parallax.ts   # 首屏与导航栏的滚动节奏（倾斜 / 折叠）
│  │        ├─ portrait-points.ts # 把头像采样成规整点阵（每格一颗代表色）
│  │        ├─ portrait-pixel.ts  # 头像：汇聚成方阵 → 长成像素 → 高斯模糊换图
│  │        ├─ moveable-text.ts   # 段落逐字打字、炸开、弹簧归位
│  │        ├─ greeting.ts        # “你好！”：打字 → 散落 → 光标变圆点 → 蓄力 → 炸开
│  │        ├─ orb-field.ts       # 浅绿底上浮的绿色光球（带景深，鼠标吸引）
│  │        ├─ swarm-field.ts     # 右侧线框里的粒子团（汇聚成牌面，鼠标排斥）
│  │        └─ text-support.ts    # 字体就绪与减弱动效检测
│  └─ api/              # 后端：Node.js + Fastify + TypeScript
│     └─ src/
│        ├─ app.ts      # 组装 Fastify 实例（可测试，可复用）
│        ├─ server.ts   # 启动入口（在这里用 Node 原生 loadEnvFile 读根目录 .env）
│        ├─ admin/      # 管理后台的公共件：session.ts（鉴权）、log-buffer.ts（日志环形缓冲）
│        └─ routes/     # hello.ts, health.ts, admin.ts, admin-console.ts, admin-files.ts
├─ services/            # 预留：其他语言的服务
│  ├─ python/           # 预留：Python 服务
│  └─ java/             # 预留：Java 服务
├─ docs/                # 文档（本文件 + screenshots/ 里的 README 配图）
├─ package.json         # npm workspaces 根，统一脚本入口
├─ tsconfig.base.json   # 共享 TypeScript 配置
├─ .env.example         # 环境变量模板
└─ .editorconfig
```

## 环境要求

- **Node.js ≥ 20.19**（本仓库在 Node 24 上验证）。用 [.nvmrc](.nvmrc) 对齐版本。
- npm（随 Node 附带）。
- 可选：Python 3、JDK 17+ —— 仅当你要启用 [services/](services/README.md) 下的服务时。

## 快速开始

```bash
# 1. 安装依赖（根目录一次即可，npm workspaces 会安装到各子包）
npm install

# 2. 启动前端 + 后端（并行）
npm run dev
```

然后打开 <http://localhost:5173>，会看到带有淡绿主题、入场动画的主页：

- 顶部导航栏：左侧是文字标识「阿根」（后续可替换为图片或自定义字体），
  右侧是五个板块 主页 / 作品 / 博客 / 留言 / 关于我，激活项带滑动高亮胶囊。
  向下滚动时整条导航栏逐渐变淡隐藏，而「阿根」与五个板块缩小并收到左上 / 右上角，
  停在那里变成两枚小胶囊（鼠标悬停或键盘聚焦时变清晰），兼顾沉浸感与可用性。
- 首屏场景：立体字「阿根」带 3D 倾斜与高光挤出厚度，随滚动逐渐加大透视、
  下沉放大分离并淡出（真正的 3D 视差）；下方有一条地面。页面加载后枫叶从上方
  落下，落到地面上或两个字上会停住，静止一会儿后淡出；鼠标划过会像一阵风那样
  带起叶子（水平或垂直挥动都可以）。
- 叶子画在固定在视口的画布上，因此滚动页面时「字、地面」移动而叶子留在屏幕
  原位，并且会与移动中的字、地面发生碰撞。
- 离开首屏后就不再落下新叶子：等首屏滚过去，空中的叶子落定、淡出后画面归于安静；
  重新滚回首屏时会再次开始落叶。

> 无障碍：当系统开启「减少动态效果」(`prefers-reduced-motion: reduce`) 时，
> 不再运行枫叶场景与视差，导航栏与首屏保持静态。

### 第二个板块：「我会什么？」

在「我是谁？」之后，同样用加高容器 + `sticky` 钉住一屏，按本地时钟播完一条
时间线（播放期间滚动锁住，播完才放行）：

1. **背景光球**：底座就是整站那层浅绿（不另起深色背景），一片绿色光球在其中
   浮现并缓慢上浮。光球按 `depth` 分远近——近处更大、更亮、上浮更快，形成明显
   景深；鼠标半径内的光球会被**快速吸引**聚集到指针附近，移开后重新散开。
2. **标题入场**：「我会什么？」四个字随滚动从屏幕上方落到面板顶部。
3. **左侧卡牌**：**先由线条把一张牌一笔一笔画出来**（上 → 右 → 下 → 左，顺时针，
   四条边分别延伸；画之前屏幕上完全看不出框的边界）→ 描完卡面淡入，这张框就成了
   牌堆的第一张牌，其余四张一开始就叠在它后面 → 五张牌从这个叠着的位置**扇形
   散开**（最左最底、最右最上，像斗地主一样互相重叠）。
   鼠标移到某张牌上，它会向左**抽出**并**转正到水平**方便看清，离开即收回。
   牌面文案见 `apps/web/src/content/skills.ts`。
4. **右侧线框**：画一个更大的框（同样自绘描边），内部用浅绿填充，另一种绿色的
   粒子在其中汇聚成一个牌面大小的粒子团；鼠标靠近时粒子被推开。框下方浮出
   「请选择卡片」。
5. **右栏场景**：选中某张牌时，右栏由粒子团**淡换成这张卡声明的场景**——卡片在
   `content/skills.ts` 里用 `scene` 指定（缺省则回退到粒子团）。目前有两个：
   - 卡 0「3D全流程」→ `compare`：三阶段对比图，两根可拖动 / 可键盘操作的分割线
     （[scene/image-compare.ts](apps/web/src/scene/image-compare.ts)）。
   - 卡 1「平面设计全流程」→ `ps-bulb`：深色**类 PS 界面**里跑一段脚本——画出来的
     指针点一下 → 拉出虚线选框 → 框内线稿灯泡从很小涨满 → 指针再点一下点亮；
     之后灯泡可点击切换亮 / 灭（[scene/ps-bulb.ts](apps/web/src/scene/ps-bulb.ts)）。
     整盏灯的明暗由单旋钮 `--lit` 用 `calc()` 派生；几何全用百分比，不注册 resize。

   **新增右栏场景**：新建 `scene/xxx.ts` 实现 `SkillSceneHandle`
   （契约见 [scene/skill-scene.ts](apps/web/src/scene/skill-scene.ts)），在
   [sections/skills.ts](apps/web/src/sections/skills.ts) 的 `SKILL_SCENE_FACTORIES`
   里注册一行，再在卡片上写 `scene: 'xxx'` 即可——多个场景各自 show / hide / 播放，
   互不影响；未注册的 id 会退化成「不显示、不吃事件」的兜底场景，页面不会崩。

> 卡牌的命中判定用**牌在扇面上的静止位置**（把指针反变换回牌的局部坐标再和矩形
> 比较），而不是它抽出之后的位置——否则牌一抽走就可能从指针下滑开，来回抖。
> 补间只在时间线跑完（`.is-settled`）之后才由 CSS 打开，避免逐帧写入和 CSS 过渡
> 打架。

调参集中在 `apps/web/src/scene/orb-field.ts` 与 `swarm-field.ts` 顶部；
卡牌数量与文案见 `apps/web/src/content/skills.ts`，牌的尺寸见 `styles.css` 里的
`--card-w`（左右两个框与卡牌共用），扇形张角与抽出量见 `sections/skills.ts`
顶部的 `FAN_SPREAD_DEG` / `EXTRACT_*`；灯泡场景的坐标与时间线见
[scene/ps-bulb.ts](apps/web/src/scene/ps-bulb.ts) 顶部的两组常量。

后端接口 `/api/hello`、`/api/health` 仍然可用，可直接 `curl` 验证。

### 标签页与路由（作品 / 博客 / 留言 / 关于我）

五个标签页走**哈希路由**（[router.ts](apps/web/src/router.ts)），路由 id 与导航项同名：

| 地址         | 页面                                                     |
| ------------ | -------------------------------------------------------- |
| `#home`      | 主页（缺省；空哈希 / 未知哈希也回落这里）                 |
| `#works`     | 作品（占位页）                                            |
| `#blog`      | 博客（占位页）                                            |
| `#message`   | 留言（占位页）                                            |
| `#about`     | 关于我（占位页）                                          |
| `#login`     | 登录 / 注册（`#login/register` 直达注册 tab）            |
| `#account/<tab>` | 个人中心 / 我的主页 / 设置（`profile` / `home` / `settings`） |

- **为什么用哈希**：产物是纯静态的，路径式路由要求每台静态服务器都配 rewrite，
  否则刷新 `/blog` 直接 404；哈希在任何 host 上刷新、分享、按后退都照常工作。
- 四个标签页目前**只有骨架**：`pages/page-shell.ts` 的通用外壳（「筹备中」小标 +
  标题 + 一句说明 + 回主页），文案在 [content/pages.ts](apps/web/src/content/pages.ts)。
  要填内容时，把对应的 `pages/xxx.ts` 换成自己的布局即可。
- **换页 = 销毁旧视图 + 建新视图**：首页那条滚动叙事（含 34 张卡的时间轴、枫叶画布）
  在有 `dispose()` 的模块里整块拆掉，回到主页再重建，所以切页不会留下旧视图，
  也不会让动画在别的页面上继续跑。滚动位置在换页时复位到页顶（首屏不清零，
  免得把浏览器恢复的刷新位置顶掉）。
- 点当前标签页的导航项 = 回到页顶（首页那条叙事顶部离得很远，不然点了像没反应）。
- DEV 钩子：`?route=<id>` 会在装配完再走一遍真实换页路径（点击标签页走的就是它），
  用来回归「旧视图拆干净了没有」——`--dump-dom` 只有它才能验换页。
- 另一组 DEV 钩子是给截图用的（`--screenshot` 只能拍文档第一个视口、又不能滚动）：
  `?shot=home|about|skills` 只留下某一个板块（`.app-shell > *:not(目标)` 全部隐藏，
  导航栏保留），`?rm=1` 强制走「减少动态」的终态分支。注意 `rm` 必须在 `router.start()`
  之前生效——`identity` / `skills` 在 `createXxx()` 里就把 `prefersReducedMotion()`
  读进局部变量了。`?wp=`（作品墙冻帧）与 `?cta=1` + `?ctareveal=1`（圆盘展开态）
  是同一套思路的另外两个实现。

### 站点账号（登录 / 注册 / 角色）

导航栏右上角：未登录是「登录 / 注册」两个链接，登录后是头像 + 昵称，悬停展开菜单
（个人中心 / 我的主页 / 设置 / 管理员后台 / 退出登录）。滚动到导航栏收成胶囊时，
账号位整个隐藏（此时右上角只剩导航胶囊）。

| 层级     | 怎么来的                                        | 能做什么                     |
| -------- | ----------------------------------------------- | ---------------------------- |
| 游客     | 未登录                                          | 浏览全部公开页面             |
| 普通用户 | 在 `#login/register` 注册                        | 账号体系内的一切本人操作     |
| 管理员   | 用下面的 CLI 建，或手改 `data/users.json` 的 role | 同上，且能登录 `/admin.html` |
| 站长     | 同上（`--role owner`）                           | 同上                          |

- **数据在 `apps/api/data/users.json`**（该目录被 `.gitignore` 忽略，同目录有 `.bak`）。
  它不在仓库里，**换机器 / 清数据之后要重新建账号**。
- **密码只存 scrypt 哈希**（`scrypt$N$r$p$salt$hash`，`node:crypto` 自带，不引原生模块）。
- **用户名与昵称是两件事**：用户名（英文 + `_ - .`，3–20 位，字母开头）只用于登录、
  不对外展示；昵称才是别人看到的名字，任意语言与符号。**用户名和邮箱都能登录**，两者都唯一。
- 邮箱只做登记，不发验证码、不做验证。
- 会话：HttpOnly cookie `agen_user`，`SameSite=Lax`，默认 7 天；签名密钥优先取
  `USER_SESSION_SECRET`，不配就自动生成到 `apps/api/data/.session-secret`（0600）。

建第一个站长（密码交互式输入，不进 shell 历史）：

```bash
npm run user:create -- \
  --username MnO4_ --nickname MnO4_ --email you@example.com --role owner
# 非交互环境（CI / 管道）：
# printf '你的密码\n' | npm run user:create -- --username ... --password-stdin
```

账号接口（全部 `/api/auth/*`）：

| 方法 | 路径        | 说明                                            |
| ---- | ----------- | ----------------------------------------------- |
| GET  | `/session`  | 当前会话；未登录也是 200 `{authenticated:false}` |
| POST | `/register` | 注册（成功即登录）；校验失败带 `field` 便于内联提示 |
| POST | `/login`    | `{identifier, password}`，用户名或邮箱均可；8 次 / 10 分钟限流 |
| POST | `/logout`   | 清 cookie                                       |

`/admin.html` 的登录仍然认 `.env` 里的 `ADMIN_USER` / `ADMIN_PASSWORD`，**另外**也接受
`users.json` 里 role 为 `admin` / `owner` 的账号（签发同一种管理 token，有效期压到 ≤2 小时）。

已知限制：管理 token 是无状态签名，账号在有效期内被降级或停用后，**已签发**的管理会话
仍然可用（最长 2 小时）。访客会话没这个问题——`/api/auth/session` 每次都回表查角色与状态。

### 平台差异

| 操作            | Windows (PowerShell)                 | Linux / macOS            |
| --------------- | ------------------------------------ | ------------------------ |
| 安装依赖        | `npm install`                        | `npm install`            |
| 启动开发环境    | `npm run dev`                        | `npm run dev`            |
| 激活 Python venv| `.venv\Scripts\Activate.ps1`         | `source .venv/bin/activate` |

> **Windows 提示**：如果 PowerShell 报 “禁止运行脚本”，请使用 `npm.cmd`
> 代替 `npm`，或执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
> 脚本本身没有任何平台专属写法，`npm run <script>` 在两个平台等价。

## 常用脚本（在根目录执行）

| 命令               | 作用                                             |
| ------------------ | ------------------------------------------------ |
| `npm run dev`      | 并行启动前端（5173）与后端（3000）                |
| `npm run dev:web`  | 只启动前端                                        |
| `npm run dev:api`  | 只启动后端                                        |
| `npm run build`    | 类型检查 + 构建前端与后端                         |
| `npm start`        | 运行构建后的后端（`apps/api/dist`）               |
| `npm run preview`  | 预览前端构建产物                                  |
| `npm run typecheck`| 对前端与后端做类型检查                            |
| `npm run clean`    | 清理构建产物与缓存                                |

## API

| 方法 | 路径                 | 说明                                              |
| ---- | -------------------- | ------------------------------------------------- |
| GET  | `/api/hello`         | 返回 `{ message, service, timestamp }`            |
| GET  | `/api/health`        | 返回 `{ status, uptime }`                         |
| GET  | `/api/admin/session` | 是否已登录 `{ authenticated, user? }`             |
| POST | `/api/admin/login`   | `{ username, password }` → 种下会话 cookie         |
| POST | `/api/admin/logout`  | 清掉会话 cookie                                   |
| GET  | `/api/admin/console/logs`   | 日志快照 `{ logs, stats }`（`?after=&limit=`） |
| GET  | `/api/admin/console/stream` | SSE：实时日志 + 每 2 秒一份进程状态            |
| POST | `/api/admin/console/clear`  | 清空服务端日志缓冲                              |
| GET  | `/api/admin/files/roots`    | 允许管理的根目录列表                            |
| GET  | `/api/admin/files/list`     | 列目录（`?root=&path=`）                        |
| GET  | `/api/admin/files/read`     | 读文本（最多 256 KB，二进制只回元信息）         |
| GET  | `/api/admin/files/raw`      | 原文件 / 下载（`?download=1`）                  |
| POST | `/api/admin/files/save`     | 保存文本（≤ 1 MB）                              |
| POST | `/api/admin/files/upload`   | 上传裸二进制（≤ 25 MB，`?overwrite=1` 覆盖）    |
| POST | `/api/admin/files/mkdir`    | 新建文件夹                                      |
| POST | `/api/admin/files/rename`   | 重命名                                          |
| POST | `/api/admin/files/remove`   | 删除（**移到 `.admin-trash/`**，不是真删）      |
| GET  | `/api/works`                | 已发布作品列表 `{ works }`（公开，无需登录）    |
| GET  | `/api/works/:slug`          | 作品详情 `{ work }`（含 README / 自定义 HTML）  |
| GET  | `/api/works/media/:file`    | 作品图片直链（内容哈希命名，可长缓存）          |
| GET  | `/api/admin/works`          | 全部作品（含草稿）                              |
| POST | `/api/admin/works`          | 新建作品                                        |
| PUT  | `/api/admin/works/:id`      | 更新作品（局部：只传一个字段也行）              |
| DELETE | `/api/admin/works/:id`    | 删除（图片移到 `.admin-trash/works-media/`）    |
| POST | `/api/admin/works/:id/publish` | 发布 / 下线 `{ published }`                  |
| POST | `/api/admin/works/reorder`  | 按 id 顺序重排（必须是全量置换）                |
| POST | `/api/admin/works/media`    | 上传作品图片（裸 `octet-stream`，≤ 25 MB）      |

开发时前端通过 Vite 代理访问 `http://localhost:5173/api/*` → 后端 `:3000`，
因此前端代码里统一使用相对路径 `/api/...`，生产环境交给反向代理即可，无需改代码。
（`preview` 也配了同一条代理，否则预览产物时管理后台的登录会 404。）

直接验证后端：

```bash
curl http://localhost:3000/api/hello
```

## 管理后台（隐藏入口 `/admin.html`）

**这个地址不在站内任何地方出现**：导航栏没有它、任何页面都不链它、页面自带
`noindex`，而且是 Vite 的**独立构建入口**——公开页面那份 bundle 里不含它的任何代码。

```bash
npm run dev                       # 前端 5173 + 后端 3000
# 打开 http://localhost:5173/admin.html
```

- **「藏起来」不是保护**，真正的门是账号密码，校验在后端
  [routes/admin.ts](apps/api/src/routes/admin.ts)。
- 凭据来自根目录 `.env`（复制 `.env.example` 再填）：

  | 变量                     | 说明                                                     |
  | ------------------------ | -------------------------------------------------------- |
  | `ADMIN_USER`             | 管理员账号                                                |
  | `ADMIN_PASSWORD`         | 管理员密码（换成只有你知道的长口令）                       |
  | `ADMIN_SESSION_SECRET`   | 会话签名密钥（HMAC-SHA256），换掉即让所有会话失效          |
  | `ADMIN_SESSION_TTL_MS`   | 可选，会话有效期，默认 8 小时                              |
  | `ADMIN_COOKIE_SECURE`    | 可选，HTTPS 部署时设 `1`（本地 http 调试**不能**开）        |
  | `ADMIN_FILE_ROOTS`       | 可选，文件管理能碰的目录白名单（格式 `名称=相对路径`，逗号分隔） |

  三项缺任何一项，`/api/admin/*` 一律 `503`（fail-closed：忘了配应该是打不开门）。
  改完要记得重启后端。
- 会话是**无状态 HMAC token，放在 HttpOnly cookie 里**：token 不进 JS 作用域
  （XSS 偷不走），前端也不往 localStorage / sessionStorage 里写任何东西。
  失败限流：同一 IP 10 分钟内 5 次机会，超过返回 429。
- 登录之后是「左侧功能卡 + 右侧内容」：`views/shell.ts` 负责装配与切换，切换时先
  `dispose()` 旧视图（控制台的 SSE 连接、编辑器的脏状态都在这一步收掉）。

### 控制台

- **只读**：这里没有「执行命令」的输入框。能跑任意命令的网页后台一旦 cookie 被拿到
  就是直接提权；要看输出有日志就够了，要跑命令请去终端。
- 后端在 `admin/log-buffer.ts` 里给 `process.stdout` / `process.stderr` 各套了一层
  旁听钩子：Fastify 的 pino 日志、`console.log`、tsx 的警告都会进环形缓冲（最近 1000 条），
  **同时照旧打到终端**。pino 的 JSON 行会被压成一行人话（`msg · METHOD URL · → 200 · 3ms`）。
- 前端通过 `GET /api/admin/console/stream`（SSE）实时渲染，断线由浏览器自动重连；
  每次 `open` 都按当前 `lastId` 补一次快照并按 id 去重，所以断线期间的行不会丢也不会重复。
- 顶部的 PID / 已运行 / 内存 / Node 版本来自每 2 秒一次的 `stats` 事件。
- URL 参数 `?view=console|files|works` 可以直接落到某个功能（截图、书签都方便）。

### 文件管理

- 能碰的目录是**白名单**，默认三处（`ADMIN_FILE_ROOTS` 可改）：
  `站点资源=apps/web/public`、`截图=shots`、`服务文档=services`。
- 客户端传的是「根 + 根内相对路径」，服务端自己拼绝对路径；`..`、绝对路径、控制字符
  一律拒绝，拼完再用 `realpath` 复核一次，符号链接也挡掉——白名单外的盘符是碰不到的。
- 文本可在页面里直接编辑（≤ 1 MB，`Ctrl+S` 保存）；超过 256 KB 的文件只预览、**禁用编辑**
  （否则保存会把文件截断）；图片直接预览；其它二进制只给下载。
- 上传支持按钮与拖拽（单文件 ≤ 25 MB，同名默认不覆盖，会先问一句）。
- **删除 = 移到仓库根的 `.admin-trash/<时间戳>/…`**（已 gitignore），误删可以从磁盘找回来；
  要彻底删就手动清那个目录。管理后台点错一次不该是不可逆事故。

### 作品

`#works` 是真实的作品列表（`pages/works.ts`）：顶部是标题 / 统计 / 搜索 / 分类筛选，
下面是 16:9 缩略图卡片；点卡片进 `#works/<slug>` 详情页。首页那段 34 张卡的滚动作品墙
也读同一份数据（少于 8 条时循环填充，撑住那段钉住叙事），卡片点进去就是同一个详情页。

两种模式，在后台新建时选：

| 模式 | 你写的 | 站点做的 |
| --- | --- | --- |
| **模板模式** | 标题、简介、标签、年份、分类、链接、封面、图集、README（Markdown） | 用统一版式渲染：面包屑 + 标题 + 正文 + 右侧事实栏 |
| **开发者模式** | **一整页 HTML**（可内嵌 `<style>` / `<script>`） | 塞进**沙箱 iframe**（`srcdoc`），站内只留一枚返回胶囊 |

- 开发者模式的页面跑在 `sandbox="allow-scripts allow-forms allow-modals allow-popups"`
  的 iframe 里，**不带 `allow-same-origin`**——它拿不到本站的 cookie 与 DOM。后端也
  刻意**没有**「原样吐出这段 HTML」的接口，那等于绕过沙箱。
- 数据落在 `apps/api/data/`（已 gitignore）：`works.json`（整份读写、原子写、每次留一份
  `.bak`）+ `works-media/`（按内容哈希命名的图片）。**单进程**设计，别让两个后端指向同一个目录。
- 图片通过 `/api/works/media/<name>` 直出，所以新增作品**不需要重新 build**；
  文件名是内容哈希，换图必然换 URL，可以放心长缓存。
- 删作品时记录先摘掉、图片再移进 `.admin-trash/works-media/`；还被子作品引用的图不会被移走。
- 后台 URL：`?view=works` 直达；`?preview=works`（仅 DEV）用假数据看版面，
  加 `&edit=<slug>` 会直接打开编辑器。

## 端口配置

复制 `.env.example` 为 `.env` 后按需修改 `PORT`（后端）与 `WEB_PORT`（前端），
以及上面管理后台的三个变量。`.env` 已被 git 忽略。

## 后续扩展

- **新增接口**：在 [apps/api/src/routes/](apps/api/src/routes/) 下加路由文件，
  然后在 [app.ts](apps/api/src/app.ts) 中注册。管理接口开头先写
  `if (!requireAdmin(request, reply)) return;`（`apps/api/src/admin/session.ts`），
  别自己判 cookie——少写一行就是少一个漏洞。
- **给管理后台加一个功能**：在 [apps/web/src/admin/views/](apps/web/src/admin/views/)
  下实现 `AdminView`（`{ element, dispose }`，`dispose` 必须把定时器 / SSE / 监听清干净），
  然后在 `views/shell.ts` 的 `NAV_ITEMS` 加一项、在 `DEFAULT_VIEWS` 里注册；文案与请求
  分别放 `api.ts` 和视图里，外壳不需要改。
- **新增前端页面**：① 在 [apps/web/src/pages/](apps/web/src/pages/) 下新建页面模块，
  返回 `RouteView`（`{ elements, mounted?, dispose }` —— `mounted` 里才量得到真实布局，
  `dispose` 必须把监听 / 画布 / 时间轴清干净）；② 在
  [components/navbar.ts](apps/web/src/components/navbar.ts) 的 `NAV_ITEMS` 里加一项
  （路由表直接用它，别在别处再抄一份）；③ 在 [main.ts](apps/web/src/main.ts) 的
  `createView` 的 `switch` 里加一个 `case`——漏了这一步 TS 会报错。
  ⚠️ `elements` 必须是 `.app-shell` 的**直接子元素**：截图模式靠
  `.app-shell > *` 隐藏同级板块（见 `sections/works.ts`）。
- **新增滚动板块**：在 [apps/web/src/sections/](apps/web/src/sections/) 下新建板块模块
  （参考 [identity.ts](apps/web/src/sections/identity.ts)：用“加大高度 + sticky 视口”的方式
  把一段滚动距离固定成一屏，屏内的动画用本地时间线自动播放，播放期间锁住滚动，
  播完才放行），
  文案放在 [apps/web/src/content/](apps/web/src/content/) 里，动画放在
  [apps/web/src/scene/](apps/web/src/scene/) 里。
- **换隐藏管理后台的地址**：把 `apps/web/admin.html` 改成你喜欢的文件名，并同步
  [vite.config.ts](apps/web/vite.config.ts) 里 `admin: html('admin.html')` 这一行。
  真正的保护仍然是登录，改名只是少被人撞见。
- **更换头像**：把图按 `portrait-1024.png` / `portrait-512.png` 两档导出到
  [apps/web/public/](apps/web/public/) 覆盖同名文件即可，代码不用改——
  [home-view.ts](apps/web/src/pages/home-view.ts) 的 `portraitWidths`（当前 `[512, 1024]`）
  会把这两档拼成 `srcset`，[sections/identity.ts](apps/web/src/sections/identity.ts)
  取图后交给采样器重新切成点阵。
  两张图**必须正方形且两档一致**（1024×1024 / 512×512）：
  `samplePortraitGrid(image, 640, 20)` 是按方图切格的，非方图会让点阵变形。
  原图还要够「硬」——采样规则是「每格保留离该格平均色最远的像素」，明暗对比不足的
  柔光图点出来会糊成一团。要加第三档（比如 2048）时才需要同步 `portraitWidths`。
- **新增其他语言的服务**：见 [services/README.md](services/README.md)。
