/**
 * 建号 CLI。
 *
 *   npm run user:create -w @agen/api -- \
 *     --username MnO4_ --nickname MnO4_ --email me@example.com --role owner
 *
 * 主要用途是**在还没有任何账号时种下第一个站长**（页面上注册出来的一律是普通用户），
 * 以及日常补一个管理员。
 *
 * 密码为什么不走命令行参数：
 *   · `$`、`!`、反引号、空格在 shell 里会被展开或吃掉，`@` 也只是碰巧安全；
 *   · 命令行参数会进 `.bash_history`，等于把密码明文留在磁盘上。
 * 所以默认交互式输入（不回显、输两遍），非交互场景用 `--password-stdin`（读 stdin 第一行）。
 */

import { createInterface } from 'node:readline';

import { createUser, usersFile } from '../users/store.js';
import { ROLE_LABEL, type Role } from '../users/types.js';
import {
  UserError,
  assertRole,
  checkEmail,
  checkNickname,
  checkPassword,
  checkUsername,
} from '../users/validate.js';

/* ---------------------------------------------------------------------------
   参数
--------------------------------------------------------------------------- */

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) continue;

    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      args.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }

    // 后面跟的不是新开关，就当它是值；否则按布尔开关记 '1'。
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args.set(body, next);
      index += 1;
    } else {
      args.set(body, '1');
    }
  }
  return args;
}

/* ---------------------------------------------------------------------------
   读密码
--------------------------------------------------------------------------- */

/** 问一句；`hidden` 时不回显（终端只显示提示语，敲进去的字符不落屏）。 */
function ask(prompt: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // `_writeToOutput` 是 readline 的私有钩子，也是 Node 官方 issue 里公认的隐藏输入做法。
    // 换掉它以后提示语也不会打印，所以上面先自己 write 一次。
    const mutable = rl as unknown as { _writeToOutput?: (text: string) => void };
    const original = mutable._writeToOutput;
    if (hidden && original) mutable._writeToOutput = () => {};

    rl.once('line', (line) => {
      if (hidden && original) mutable._writeToOutput = original;
      rl.close();
      process.stdout.write('\n');
      resolve(line);
    });
  });
}

/** 非 TTY（管道、CI）时把 stdin 全读进来，按行返回。 */
async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

/* ---------------------------------------------------------------------------
   主流程
--------------------------------------------------------------------------- */

function die(message: string): never {
  process.stderr.write(`✖ ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const username = args.get('username');
  const email = args.get('email');
  const nickname = args.get('nickname') ?? username;
  const roleRaw = args.get('role') ?? 'user';

  if (!username || !email) {
    die(
      '用法：npm run user:create -- --username <用户名> --nickname <昵称> --email <邮箱> ' +
        '[--role user|admin|owner] [--password-stdin]',
    );
  }
  if (!nickname) die('必须给一个昵称（--nickname）。');

  const role: Role = assertRole(roleRaw);
  checkUsername(username);
  checkNickname(nickname);
  checkEmail(email);

  // 取密码：管道优先，否则交互式输两遍。
  let password: string;
  if (args.has('password-stdin') || process.stdin.isTTY !== true) {
    const lines = await readStdinLines();
    password = (lines[0] ?? '').trim();
    if (!password) die('从 stdin 读不到密码（用 --password-stdin 时请把密码放在第一行）。');
  } else {
    password = await ask('密码（输入不回显）：', true);
    const again = await ask('再输一次：', true);
    if (password !== again) die('两次输入的密码不一致。');
  }
  checkPassword(password);

  const record = await createUser({ username, nickname, email, password, role });
  const lines = [
    `✔ 已创建${ROLE_LABEL[record.role]}「${record.nickname}」`,
    `  用户名：${record.username}`,
    `  邮箱：${record.email}`,
    `  数据文件：${usersFile}`,
  ];
  if (record.role === 'owner' || record.role === 'admin') {
    lines.push('  这个账号可以直接登录 /admin.html。');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  // 校验错误（UserError）的 message 就是给用户看的那句话；其它错误原样打出来。
  die(error instanceof UserError || error instanceof Error ? error.message : String(error));
});
