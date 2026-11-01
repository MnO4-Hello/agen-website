/**
 * 回复框。
 *
 * 三种身份的三种形态（这是本模块最容易被写歪的地方）：
 *
 *   · **登录用户**：不出现验证区，提交时也不带 `captcha`；
 *   · **游客**：出现验证区。验证**在首次聚焦输入框时自动开始**——不用点按钮、不用
 *     读题，用户打完字的这几秒里，浏览器已经在后台把工作量证明算完了；
 *   · **还没确认登录态**（`unknown`，通常只有几十毫秒）：先禁用提交。这个窗口里如果
 *     按游客渲染，登录用户会短暂看到一个「正在验证」，观感像 bug。
 *
 * 反刷的客户端部分也在这里：蜜罐字段（`.bp-reply__hp`，视觉上挪出屏幕）。
 * 真正的人机验证见 `apps/api/src/blog/captcha.ts`（自托管工作量证明）与 `pow.ts`。
 */

import type { AuthState } from '../auth/session';
import { BLOG_COPY } from '../content/blog';
import { solvePuzzle } from './pow';
import type { Challenge, ReplyCreated, ReplyInput, ReplyView, Solution } from './types';
import type { Outcome } from './api';

const MAX_LENGTH = 2000;

export interface ReplyFormOptions {
  submit: (input: ReplyInput) => Promise<Outcome<ReplyCreated>>;
  /** 领一道工作量证明题（`GET /api/blog/captcha`）。失败返回 `null`。 */
  requestCaptcha: () => Promise<Challenge | null>;
  onPosted: (reply: ReplyView, replyCount: number) => void;
}

export interface ReplyFormHandle {
  element: HTMLFormElement;
  setAuth(state: AuthState): void;
  setReplyTo(floor: number, nickname: string): void;
  clearReplyTo(): void;
  focus(): void;
  dispose(): void;
}

export function createReplyForm(options: ReplyFormOptions): ReplyFormHandle {
  let closed = false;
  let auth: AuthState = { status: 'unknown' };
  let busy = false;
  let replyToFloor: number | null = null;
  let statusTimer = 0;

  /** 已经算好的解；`null` = 还没验证过。一张题只能用一次。 */
  let solution: Solution | null = null;
  /** 正在进行的验证；并发调用共用同一个 Promise，不会重复领题、重复算。 */
  let pending: Promise<Solution | null> | null = null;
  let verifyPercent = 0;
  const verifyAbort = new AbortController();
  /** 只自动开始一次：聚焦才开算，避免「页面一打开就替所有人算哈希」。 */
  let started = false;

  const form = document.createElement('form');
  form.className = 'bp-reply';
  form.noValidate = true;

  /* 引用条 ---------------------------------------------------------------- */
  const quote = document.createElement('div');
  quote.className = 'bp-reply__quote';
  quote.hidden = true;

  const quoteText = document.createElement('span');
  quoteText.className = 'bp-reply__quote-text';

  const quoteCancel = document.createElement('button');
  quoteCancel.type = 'button';
  quoteCancel.className = 'bp-reply__quote-cancel';
  quoteCancel.textContent = BLOG_COPY.replyCancelQuote;
  quoteCancel.addEventListener('click', () => clearReplyTo());

  quote.append(quoteText, quoteCancel);

  /* 正文 ------------------------------------------------------------------ */
  const textarea = document.createElement('textarea');
  textarea.className = 'bp-reply__input';
  textarea.rows = 4;
  textarea.maxLength = MAX_LENGTH;
  textarea.placeholder = BLOG_COPY.replyPlaceholder;
  textarea.setAttribute('aria-label', '回复正文');

  const field = document.createElement('div');
  field.className = 'bp-reply__field';
  field.append(textarea);

  /* 验证区 ---------------------------------------------------------------- */
  const verifyBox = document.createElement('div');
  verifyBox.className = 'bp-verify';
  verifyBox.dataset.state = 'idle';
  verifyBox.setAttribute('role', 'status');
  verifyBox.setAttribute('aria-live', 'polite');

  const verifyText = document.createElement('span');
  verifyText.className = 'bp-verify__text';

  const verifyBar = document.createElement('span');
  verifyBar.className = 'bp-verify__bar';
  const verifyFill = document.createElement('i');
  verifyFill.className = 'bp-verify__fill';
  verifyBar.append(verifyFill);

  const verifyRetry = document.createElement('button');
  verifyRetry.type = 'button';
  verifyRetry.className = 'bp-verify__retry';
  verifyRetry.textContent = BLOG_COPY.verifyRetry;
  verifyRetry.hidden = true;
  verifyRetry.addEventListener('click', () => {
    resetVerify();
    void ensureVerified();
  });

  verifyBox.append(verifyText, verifyBar, verifyRetry);

  /* 蜜罐：视觉上挪出屏幕，`display:none` 会被一部分脚本直接跳过 ------------- */
  const honeypot = document.createElement('input');
  honeypot.className = 'bp-reply__hp';
  honeypot.type = 'text';
  honeypot.name = 'website';
  honeypot.tabIndex = -1;
  honeypot.autocomplete = 'off';
  honeypot.setAttribute('aria-hidden', 'true');

  /* 底栏 ------------------------------------------------------------------ */
  const foot = document.createElement('div');
  foot.className = 'bp-reply__foot';

  const note = document.createElement('span');
  note.className = 'bp-reply__note';

  const count = document.createElement('span');
  count.className = 'bp-reply__count';

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'bl-btn bp-reply__submit';
  submit.textContent = BLOG_COPY.replySubmit;

  foot.append(note, count, submit);

  const status = document.createElement('p');
  status.className = 'bp-reply__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  form.append(quote, field, verifyBox, honeypot, foot, status);

  /* 状态渲染 -------------------------------------------------------------- */

  function setStatus(text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('is-error', tone === 'error');
    status.classList.toggle('is-ok', tone === 'ok');
    if (statusTimer) window.clearTimeout(statusTimer);
    // 成功提示自动淡出；错误留着等下一次操作覆盖——它通常需要人看见。
    if (text && tone !== 'error') {
      statusTimer = window.setTimeout(() => {
        status.textContent = '';
        status.hidden = true;
      }, 4000);
    }
  }

  function updateCount(): void {
    const length = Array.from(textarea.value).length;
    count.textContent = `${length} / ${MAX_LENGTH}`;
    count.classList.toggle('is-over', length > MAX_LENGTH);
  }

  /** 验证区的四种形态。真实判定在服务端，这里只负责别让用户猜。 */
  function paintVerify(state: 'idle' | 'working' | 'ready' | 'error', text?: string): void {
    verifyBox.dataset.state = state;
    verifyBox.classList.toggle('is-ok', state === 'ready');
    verifyBox.classList.toggle('is-error', state === 'error');
    // 游客且真的开始验证了才占位：空着的一颗虚线药丸比什么都不显示更让人困惑。
    verifyBox.hidden = auth.status !== 'guest' || state === 'idle';
    verifyBar.hidden = state !== 'working';
    verifyRetry.hidden = state !== 'error';
    verifyFill.style.width = `${verifyPercent}%`;

    if (text) {
      verifyText.textContent = text;
      return;
    }
    if (state === 'working') verifyText.textContent = `${BLOG_COPY.verifyWorking} ${verifyPercent}%`;
    else if (state === 'ready') verifyText.textContent = BLOG_COPY.verifyDone;
    else if (state === 'error') verifyText.textContent = BLOG_COPY.verifyFailed;
    else verifyText.textContent = '';
  }

  function refreshMeta(): void {
    const guest = auth.status === 'guest';
    const unknown = auth.status === 'unknown';
    const mute = auth.status === 'user' ? auth.moderation : null;
    note.classList.toggle('is-muted', Boolean(mute));
    if (unknown) note.textContent = '正在确认登录状态…';
    else if (guest) note.textContent = BLOG_COPY.replyGuestNotice;
    else if (mute) {
      // 与留言板同一句话术：禁言到期时间与原因都由服务端排好版下发，前端只拼。
      const when = mute.mutedLabel === '永久' ? '永久' : `至 ${mute.mutedLabel}`;
      note.textContent = `你已被禁言${when}${mute.mutedReason ? `（原因：${mute.mutedReason}）` : ''}，暂时不能回复。`;
    } else note.textContent = BLOG_COPY.replyLoginNotice;
    submit.disabled = busy || unknown || Boolean(mute) || Array.from(textarea.value).length < 2;
    submit.textContent = busy ? BLOG_COPY.replySubmitting : BLOG_COPY.replySubmit;
  }

  function clearReplyTo(): void {
    replyToFloor = null;
    quote.hidden = true;
    quoteText.textContent = '';
  }

  function setReplyTo(floor: number, nickname: string): void {
    replyToFloor = floor;
    quoteText.textContent = `${BLOG_COPY.replyQuoteTo} ${nickname} #${floor}`;
    quote.hidden = false;
    focus();
  }

  function focus(): void {
    textarea.focus({ preventScroll: false });
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* 验证 ------------------------------------------------------------------ */

  function resetVerify(): void {
    solution = null;
    pending = null;
    verifyPercent = 0;
    started = false;
    paintVerify('idle');
  }

  /**
   * 领题 → 算 → 存起来。
   *
   * 并发调用共用 `pending`：用户连点两次提交，也只会算一次、只用一张题。
   */
  function ensureVerified(): Promise<Solution | null> {
    if (solution) return Promise.resolve(solution);
    if (pending) return pending;
    if (closed || auth.status !== 'guest') return Promise.resolve(null);

    started = true;
    verifyPercent = 0;
    paintVerify('working');

    pending = (async (): Promise<Solution | null> => {
      const challenge = await options.requestCaptcha();
      const fetchedAt = Date.now();
      if (closed) return null;
      if (!challenge) {
        paintVerify('error');
        return null;
      }

      try {
        const solved = await solvePuzzle(challenge, {
          signal: verifyAbort.signal,
          onProgress: (percent) => {
            if (closed) return;
            verifyPercent = percent;
            paintVerify('working');
          },
        });
        if (closed) return null;

        /*
         * 服务端要求「签发后至少过 minElapsedMs 才收」。机器算得快的时候（实测 0.1 秒），
         * 用户手一快就会撞上 too_fast；这里把差额等掉，让正常提交永远不会被判「太快」。
         * 注意它挡不住脚本——那是题量（MAX_NUMBER）与限流的活。
         */
        const remaining = fetchedAt + challenge.minElapsedMs - Date.now();
        if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
        if (closed) return null;

        solution = solved;
        paintVerify('ready', `${BLOG_COPY.verifyDone} · ${(solved.took / 1000).toFixed(1)}s`);
        return solved;
      } catch (error) {
        if (closed) return null;
        if (error instanceof DOMException && error.name === 'AbortError') return null;
        paintVerify('error');
        return null;
      } finally {
        pending = null;
      }
    })();

    return pending;
  }

  textarea.addEventListener('focus', () => {
    if (started || auth.status !== 'guest' || busy) return;
    void ensureVerified();
  });

  textarea.addEventListener('input', () => {
    updateCount();
    refreshMeta();
  });

  /* 提交 ------------------------------------------------------------------ */

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitReply();
  });

  async function submitReply(): Promise<void> {
    if (closed || busy || auth.status === 'unknown') return;

    const body = textarea.value.trim();
    if (Array.from(body).length < 2) {
      setStatus(BLOG_COPY.replyTooShort, 'error');
      return;
    }

    // 先锁住：避免「验证途中用户又点了一次」把同一张题提交两遍。
    busy = true;
    refreshMeta();

    let captcha: Solution | null = null;
    if (auth.status === 'guest') {
      // 可能还没验证（用户几乎没停顿就点了提交）：这里等它算完再发。
      captcha = await ensureVerified();
      if (closed) return;
      if (!captcha) {
        busy = false;
        refreshMeta();
        setStatus(BLOG_COPY.verifyBlocked, 'error');
        return;
      }
    }

    const result = await options.submit({
      body,
      replyToFloor,
      captcha,
      honeypot: honeypot.value,
    });
    if (closed) return;

    busy = false;

    if (result.ok) {
      textarea.value = '';
      honeypot.value = '';
      clearReplyTo();
      updateCount();
      refreshMeta();
      setStatus(BLOG_COPY.replyPosted, 'ok');
      // 一张题只能用一次：成功之后必须重新领、重新算，否则下一条必然报「已用过」。
      resetVerify();
      options.onPosted(result.data.reply, result.data.replyCount);
      return;
    }

    // 被主动取消：什么都不用做。
    if (!result.message) {
      refreshMeta();
      return;
    }

    // 验证相关的失败都重来一次（服务端可能已经把它消费掉了）。
    if (
      result.error === 'captcha_failed' ||
      result.error === 'captcha_expired' ||
      result.error === 'captcha_missing' ||
      result.error === 'too_fast'
    ) {
      resetVerify();
      if (auth.status === 'guest') void ensureVerified();
    }

    setStatus(result.message, 'error');
    refreshMeta();
  }

  updateCount();
  refreshMeta();

  return {
    element: form,
    setAuth(state) {
      const wasGuest = auth.status === 'guest';
      auth = state;
      refreshMeta();
      if (state.status === 'guest' && !wasGuest) resetVerify();
      if (state.status === 'user') {
        resetVerify();
        verifyBox.hidden = true;
      }
    },
    setReplyTo,
    clearReplyTo,
    focus,
    dispose() {
      closed = true;
      if (statusTimer) window.clearTimeout(statusTimer);
      verifyAbort.abort();
    },
  };
}
