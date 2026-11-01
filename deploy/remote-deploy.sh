#!/usr/bin/env bash
#
# 服务器侧部署脚本。
#
# 代码不是在这里拉下来的：本地 `git push deploy main` 会把新提交直接推进这台机器的
# 工作区（仓库配了 `receive.denyCurrentBranch=updateInstead`），所以脚本只负责
# 「装依赖（必要时）→ 构建 → 重启 → 自检」。
#
# 用法（本地一条命令）：
#   npm run deploy
# 等价于：
#   git push deploy main && ssh agen-server bash /srv/agen-website/deploy/remote-deploy.sh
#
# 为什么不在这里 `git pull`：这台 ECS 到 github.com:443 是**间歇性**可通的
# （实测三次握手只成功一次，HTTPS 请求经常 10s 超时），`git pull` 会随机卡死。
# 改成「本地 push 进来」之后，服务器完全不需要访问外网，推没推成功本地立刻能看到。

set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_DIR"

# pm2 装在 /usr/local/bin，非登录 shell 的 PATH 里可能没有。
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH}"
command -v pm2 >/dev/null 2>&1 || { echo "✗ 找不到 pm2，检查 /usr/local/bin"; exit 1; }

# 依赖装过就打个记号，下次只比 package-lock 的哈希，变了才重装（npm ci 会先删
# 整个 node_modules，没必要每次部署都跑一遍）。
STAMP=".deploy/lock-hash"

echo "▶ 目标提交：$(git log --oneline -1)"
echo "▶ 运行环境：Node $(node -v) / npm $(npm -v)"

lock_hash=$(md5sum package-lock.json | cut -d' ' -f1)
mkdir -p .deploy
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$lock_hash" ]; then
  echo "▶ 依赖有变化，执行 npm ci"
  npm ci --no-audit --no-fund
  printf '%s\n' "$lock_hash" > "$STAMP"
else
  echo "▶ 依赖未变化，跳过 npm ci（要强制重装：rm $STAMP）"
fi

echo "▶ 构建（web + api）"
npm run build

echo "▶ 重启 agen-api"
pm2 restart agen-api --update-env >/dev/null
pm2 save >/dev/null

echo "▶ 自检"
ok=0
for _ in 1 2 3 4 5 6; do
  if curl -fsS -m 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  echo "✗ 后端没起来，看日志：pm2 logs agen-api --lines 50"
  pm2 list --no-color | sed -n '1,6p'
  exit 1
fi

echo "✓ 后端健康：$(curl -fsS -m 3 http://127.0.0.1:3000/api/health)"
echo "✓ 站点形态：$(curl -fsS -m 3 http://127.0.0.1:3000/api/site/config)"
echo "✓ 门面自检：首页 $(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1/)"
echo "✓ 部署完成"
