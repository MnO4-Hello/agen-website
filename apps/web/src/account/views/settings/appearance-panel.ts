/**
 * 设置 · 外观（横幅 / 背景 / 主题 / 自定义 CSS）
 *
 * 三块内容，安全等级依次上升：
 *
 *   1. **上传图**——走服务端白名单（只认 magic byte），不涉及任何注入面；
 *   2. **主题四色**——直接写成 `.uprofile` 上的四个 CSS 变量，零风险；
 *   3. **自定义 CSS**——唯一一块需要「作用域化 + 黑名单」的东西，说明写在页面上，
 *      而不是只写在代码注释里。
 */

import { APPEARANCE_COPY } from '../../../content/account';
import { removeAccountMedia, uploadAccountMedia } from '../../api';
import { checkCssInput, cssByteLength, scopeCss, CSS_MAX_BYTES } from '../../css-scope';
import {
  accBlock,
  accButton,
  accField,
  accInput,
  accStatus,
  accTextArea,
  charCount,
  el,
  pickImage,
} from '../../pieces';
import {
  DEFAULT_THEME,
  THEME_PRESETS,
  type MyProfile,
  type ProfileTheme,
} from '../../types';
import type { SettingsHub, SettingsPanel } from './hub';

const THEME_KEYS: readonly { key: keyof ProfileTheme; label: string }[] = [
  { key: 'accent', label: APPEARANCE_COPY.accent },
  { key: 'accentStrong', label: APPEARANCE_COPY.accentStrong },
  { key: 'surface', label: APPEARANCE_COPY.surface },
  { key: 'text', label: APPEARANCE_COPY.text },
];

interface MediaRowHandle {
  element: HTMLElement;
  sync(data: MyProfile): void;
}

function mediaRow(
  hub: SettingsHub,
  options: {
    kind: 'cover' | 'background';
    hint: string;
    variant: string;
  },
): MediaRowHandle {
  const preview = el('span', {
    className: `acc-media__preview acc-media__preview--${options.variant}`,
  });
  const remove = accButton({
    label: '移除',
    tone: 'danger',
    icon: 'trash',
    onClick: () => {
      void removeAccountMedia(options.kind).then((result) => {
        if (!result.ok) {
          hub.status(result.message, 'error');
          return;
        }
        hub.adoptMedia(result.data);
        hub.status('已移除。', 'ok');
      });
    },
  });
  const upload = accButton({
    label: '上传',
    icon: 'upload',
    onClick: () =>
      pickImage((file) => {
        hub.status('正在上传…');
        void uploadAccountMedia(options.kind, file).then((result) => {
          if (!result.ok) {
            hub.status(result.message, 'error');
            return;
          }
          hub.adoptMedia(result.data);
          hub.status('已更新。', 'ok');
        });
      }),
  });

  const element = el('div', { className: 'acc-media' }, [
    preview,
    el('div', { className: 'acc-media__side' }, [
      el('div', { className: 'acc-media__actions' }, [upload, remove]),
      el('span', { className: 'acc-field__hint', text: options.hint }),
    ]),
  ]);

  return {
    element,
    sync(data: MyProfile): void {
      const url =
        options.kind === 'cover' ? data.profile.coverUrl : data.profile.backgroundUrl;
      preview.replaceChildren();
      if (url) {
        const img = el('img', { attrs: { src: url, alt: '', loading: 'lazy', decoding: 'async' } });
        preview.append(img);
      } else {
        preview.append(el('span', { text: '未设置' }));
      }
      remove.disabled = !url;
    },
  };
}

export function createAppearancePanel(hub: SettingsHub): SettingsPanel {
  /* -------------------------------------------------------------------------
     横幅 / 背景
  ------------------------------------------------------------------------- */

  const coverRow = mediaRow(hub, {
    kind: 'cover',
    hint: APPEARANCE_COPY.coverHint,
    variant: 'cover',
  });
  const backgroundRow = mediaRow(hub, {
    kind: 'background',
    hint: APPEARANCE_COPY.backgroundHint,
    variant: 'background',
  });

  const mediaBlock = accBlock({ title: APPEARANCE_COPY.cover, note: APPEARANCE_COPY.coverHint });
  mediaBlock.body.append(coverRow.element);

  const backgroundBlock = accBlock({
    title: APPEARANCE_COPY.background,
    note: APPEARANCE_COPY.backgroundHint,
  });
  backgroundBlock.body.append(backgroundRow.element);

  /* -------------------------------------------------------------------------
     主题
  ------------------------------------------------------------------------- */

  const presetRow = el('div', { className: 'acc-theme__presets' });
  const presetButtons: { id: string; node: HTMLButtonElement; theme: ProfileTheme }[] = [];

  for (const preset of THEME_PRESETS) {
    const swatch = el('span', { className: 'acc-theme__swatch' });
    swatch.style.background = `linear-gradient(135deg, ${preset.theme.accent} 0 55%, ${preset.theme.surface} 55% 100%)`;
    const button = el(
      'button',
      { className: 'acc-theme__preset', attrs: { type: 'button', 'aria-pressed': 'false' } },
      [swatch, el('span', { text: preset.label })],
    );
    button.addEventListener('click', () => {
      hub.patch({ theme: { ...preset.theme } });
      paintTheme({ ...preset.theme });
    });
    presetButtons.push({ id: preset.id, node: button, theme: preset.theme });
    presetRow.append(button);
  }

  const colorInputs = new Map<keyof ProfileTheme, { color: HTMLInputElement; hex: HTMLInputElement }>();
  const colorsGrid = el('div', { className: 'acc-theme__colors' });

  for (const item of THEME_KEYS) {
    const color = el('input', { attrs: { type: 'color', 'aria-label': item.label } });
    const hex = accInput({ value: DEFAULT_THEME[item.key] });
    hex.classList.add('acc-color__hex');
    hex.setAttribute('aria-label', `${item.label} 色值`);

    const commit = (value: string): void => {
      const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
      if (!normalized) return;
      const next = { ...hub.draft().theme, [item.key]: normalized } as ProfileTheme;
      hub.patch({ theme: next });
      paintTheme(next);
    };

    color.addEventListener('input', () => {
      hex.value = color.value;
      commit(color.value);
    });
    hex.addEventListener('input', () => {
      if (/^#[0-9a-f]{6}$/i.test(hex.value.trim())) {
        color.value = hex.value.trim().toLowerCase();
        commit(hex.value.trim());
      }
    });

    colorInputs.set(item.key, { color, hex });
    colorsGrid.append(
      el('label', { className: 'acc-color' }, [
        color,
        el('span', { className: 'acc-field__label', text: item.label }),
        hex,
      ]),
    );
  }

  /** 一小块实时样例：改颜色要能立刻看见，否则得先保存再切到「我的主页」看。 */
  const sample = el('div', { className: 'acc-theme__sample' }, [
    el('span', { className: 'acc-theme__sample-title', text: '样例' }),
    el('span', { className: 'acc-theme__sample-pill', text: '标签' }),
    el('span', { className: 'acc-theme__sample-btn', text: '按钮' }),
  ]);

  const paintTheme = (theme: ProfileTheme): void => {
    sample.style.setProperty('--sample-accent', theme.accent);
    sample.style.setProperty('--sample-surface', theme.surface);
    sample.style.setProperty('--sample-text', theme.text);
    for (const [key, handle] of colorInputs) {
      handle.color.value = theme[key];
      handle.hex.value = theme[key];
    }
    for (const preset of presetButtons) {
      const active = THEME_KEYS.every((item) => preset.theme[item.key] === theme[item.key]);
      preset.node.setAttribute('aria-pressed', String(active));
    }
  };

  const resetTheme = accButton({
    label: APPEARANCE_COPY.resetTheme,
    tone: 'ghost',
    icon: 'refresh',
    onClick: () => {
      hub.patch({ theme: { ...DEFAULT_THEME } });
      paintTheme({ ...DEFAULT_THEME });
    },
  });

  const themeBlock = accBlock({ title: APPEARANCE_COPY.theme, note: APPEARANCE_COPY.themeHint2 });
  themeBlock.body.append(
    sample,
    el('div', { className: 'acc-field__head' }, [
      el('span', { className: 'acc-field__label', text: APPEARANCE_COPY.themePresets }),
      resetTheme,
    ]),
    presetRow,
    colorsGrid,
  );

  /* -------------------------------------------------------------------------
     自定义 CSS
  ------------------------------------------------------------------------- */

  const cssArea = accTextArea({
    value: '',
    rows: 12,
    placeholder: '/* 例如 */\n.uprofile__name { letter-spacing: 0.06em; }',
    onInput: (value) => {
      hub.patch({ customCss: value });
      paintCss(value);
    },
  });
  cssArea.classList.add('acc-input--mono');

  const cssStatus = accStatus();
  const cssSample = el('code', { className: 'acc-csssample' });
  const cssCount = el('span', { className: 'acc-field__count' });

  const cssField = accField({
    label: APPEARANCE_COPY.css,
    control: cssArea,
    hint: APPEARANCE_COPY.cssHint,
  });
  cssField.element
    .querySelector('.acc-field__head')
    ?.append(cssCount);

  const paintCss = (css: string): void => {
    const bytes = cssByteLength(css);
    cssCount.textContent = `${charCount(css)} 字 / ${bytes} / ${CSS_MAX_BYTES} 字节`;
    cssCount.classList.toggle('is-over', bytes > CSS_MAX_BYTES);

    const check = checkCssInput(css);
    if (!check.ok) {
      cssStatus.set(check.message, 'error');
    } else {
      cssStatus.set('格式看起来没问题。');
    }

    const preview = scopeCss(css, '.uprofile', 'up');
    const first = preview.text.split('}')[0];
    cssSample.textContent = first ? `${first}}` : '（还没写）';
    if (preview.dropped.length > 0) {
      cssStatus.set(preview.dropped.join('；'), 'error');
    }
  };

  const cssBlock = accBlock({ title: APPEARANCE_COPY.css, note: APPEARANCE_COPY.cssNote });
  cssBlock.body.append(cssField.element, cssStatus.element, cssSample);

  /* -------------------------------------------------------------------------
     组装
  ------------------------------------------------------------------------- */

  const element = el('div', {}, [
    mediaBlock.element,
    backgroundBlock.element,
    themeBlock.element,
    cssBlock.element,
  ]);

  return {
    element,
    sync(data: MyProfile): void {
      coverRow.sync(data);
      backgroundRow.sync(data);

      // 从 draft 渲染：它就是「用户眼前这份表单」，服务端的新值由 settings-tab 灌进来。
      const draft = hub.draft();
      paintTheme(draft.theme);
      cssArea.value = draft.customCss;
      paintCss(draft.customCss);
    },
  };
}
