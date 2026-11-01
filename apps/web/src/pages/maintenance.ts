/**
 * `SITE_MODE=maintenance` 时的整站关闭页。
 *
 * 它**不挂在任何路由上**，也不渲染导航栏——`main.ts` 在拿到配置之后直接把它塞进
 * `#app` 就结束，路由器根本不启动。所以这一页不能依赖任何站点样式或脚本，
 * 自带全部结构。
 *
 * 为什么前端也要有这一层（Nginx 直接 `return 503` 更彻底）：反向代理的配置可能
 * 没跟着改、或者有人直接用后端端口访问。两道门总比一道可靠，而且这一页带说明文字，
 * 比一个光秃秃的 503 更像「站点主动关闭」而不是「服务器挂了」。
 */

import { CTA_EMAIL } from '../content/cta';
import { MAINTENANCE_COPY } from '../content/pages';

export function createMaintenancePage(): HTMLElement {
  const root = document.createElement('main');
  root.className = 'site-maintenance';

  const inner = document.createElement('div');
  inner.className = 'site-maintenance__inner';

  const badge = document.createElement('p');
  badge.className = 'site-maintenance__badge';
  badge.textContent = MAINTENANCE_COPY.badge;

  const title = document.createElement('h1');
  title.className = 'site-maintenance__title';
  title.textContent = MAINTENANCE_COPY.title;

  const note = document.createElement('p');
  note.className = 'site-maintenance__note';
  note.textContent = MAINTENANCE_COPY.note;

  const mail = document.createElement('a');
  mail.className = 'site-maintenance__mail';
  mail.href = `mailto:${CTA_EMAIL}`;
  mail.textContent = `${MAINTENANCE_COPY.mailLabel} · ${CTA_EMAIL}`;

  inner.append(badge, title, note, mail);
  root.append(inner);
  return root;
}
