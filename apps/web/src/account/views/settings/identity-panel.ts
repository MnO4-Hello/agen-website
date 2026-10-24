/**
 * 设置 · 资料
 *
 * 头像走「立即上传」，其余字段都写进 draft 等保存。
 *
 * 两个刻意的设计：
 *
 *   · **邮箱旁边有一个条件出现的「当前密码」**。改邮箱要验密码（邮箱是找回账号的
 *     唯一凭据），但平时不该让人看见一个多余的密码框——所以只有当输入框里的值
 *     和已保存的值不一样时才显示它。
 *   · **每个控件记 `touched`**。外部数据（保存成功、换账号）回来时只写没被用户
 *     碰过的控件，否则正在输入的字会被服务端的响应冲掉。
 */

import { createAvatar } from '../../../components/avatar';
import { GENDER_LABEL, IDENTITY_COPY } from '../../../content/account';
import { removeAccountMedia, uploadAccountMedia } from '../../api';
import {
  accBlock,
  accButton,
  accField,
  accInput,
  accSelect,
  accTextArea,
  charCount,
  el,
  pickImage,
} from '../../pieces';
import { LIMITS, type Gender, type MyProfile } from '../../types';
import type { SettingsHub, SettingsPanel } from './hub';

const GENDER_OPTIONS: readonly { value: Gender; label: string }[] = (
  ['none', 'male', 'female', 'other'] as const
).map((value) => ({ value, label: GENDER_LABEL[value] }));

export function createIdentityPanel(hub: SettingsHub): SettingsPanel {

  /* -------------------------------------------------------------------------
     头像：立即上传，不进 draft
  ------------------------------------------------------------------------- */

  const avatarPreview = el('span', {
    className: 'acc-media__preview acc-media__preview--avatar',
  });
  const avatarRemove = accButton({
    label: IDENTITY_COPY.avatarRemove,
    tone: 'danger',
    icon: 'trash',
    onClick: () => {
      void removeAccountMedia('avatar').then((result) => {
        if (!result.ok) {
          hub.status(result.message, 'error');
          return;
        }
        hub.adoptMedia(result.data);
        hub.status('头像已移除。', 'ok');
      });
    },
  });

  const avatarUpload = accButton({
    label: IDENTITY_COPY.avatarUpload,
    icon: 'upload',
    onClick: () =>
      pickImage((file) => {
        hub.status('正在上传头像…');
        void uploadAccountMedia('avatar', file).then((result) => {
          if (!result.ok) {
            hub.status(result.message, 'error');
            return;
          }
          hub.adoptMedia(result.data);
          hub.status('头像已更新。', 'ok');
        });
      }),
  });

  const avatarRow = el('div', { className: 'acc-media' }, [
    avatarPreview,
    el('div', { className: 'acc-media__side' }, [
      el('div', { className: 'acc-media__actions' }, [avatarUpload, avatarRemove]),
      el('span', { className: 'acc-field__hint', text: IDENTITY_COPY.avatarHint }),
    ]),
  ]);

  /* -------------------------------------------------------------------------
     文本字段
  ------------------------------------------------------------------------- */

  const nicknameInput = accInput({
    value: '',
    onInput: (value) => hub.patch({ nickname: value }),
  });
  const nicknameField = accField({
    label: IDENTITY_COPY.nickname,
    control: nicknameInput,
    hint: IDENTITY_COPY.nicknameHint,
  });

  const emailInput = accInput({
    value: '',
    type: 'email',
    inputMode: 'email',
    onInput: (value) => {
      hub.patch({ email: value });
      syncPasswordRow();
    },
  });
  const emailField = accField({
    label: IDENTITY_COPY.email,
    control: emailInput,
    hint: IDENTITY_COPY.emailHint,
  });

  const passwordInput = accInput({
    value: '',
    type: 'password',
    autocomplete: 'current-password',
  });
  const passwordField = accField({
    label: IDENTITY_COPY.currentPassword,
    control: passwordInput,
    hint: IDENTITY_COPY.currentPasswordHint,
  });
  passwordField.element.hidden = true;

  /** 只有「输入框里的邮箱」和「已保存的邮箱」不一样时才要密码。 */
  function syncPasswordRow(): void {
    const next = emailInput.value.trim();
    const changed = next !== hub.user().email;
    passwordField.element.hidden = !changed;
    if (!changed) passwordInput.value = '';
  }

  const signatureInput = accInput({
    value: '',
    onInput: (value) => {
      hub.patch({ signature: value });
      signatureField.setCount(charCount(value));
    },
  });
  const signatureField = accField({
    label: IDENTITY_COPY.signature,
    control: signatureInput,
    hint: IDENTITY_COPY.signatureHint,
    counter: { max: LIMITS.signature },
  });

  const bioArea = accTextArea({
    value: '',
    rows: 5,
    onInput: (value) => {
      hub.patch({ bio: value });
      bioField.setCount(charCount(value));
    },
  });
  const bioField = accField({
    label: IDENTITY_COPY.bio,
    control: bioArea,
    hint: IDENTITY_COPY.bioHint,
    counter: { max: LIMITS.bio },
  });

  const genderSelect = accSelect(GENDER_OPTIONS, 'none', (value) => hub.patch({ gender: value }));
  const genderField = accField({ label: IDENTITY_COPY.gender, control: genderSelect });

  const birthdayInput = accInput({
    value: '',
    type: 'date',
    onInput: (value) => hub.patch({ birthday: value }),
  });
  const birthdayField = accField({ label: IDENTITY_COPY.birthday, control: birthdayInput });

  const regionInput = accInput({
    value: '',
    onInput: (value) => hub.patch({ region: value }),
  });
  const regionField = accField({
    label: IDENTITY_COPY.region,
    control: regionInput,
    hint: IDENTITY_COPY.regionHint,
  });

  const base = accBlock({ title: IDENTITY_COPY.title, note: IDENTITY_COPY.note });
  base.body.append(
    avatarRow,
    nicknameField.element,
    emailField.element,
    passwordField.element,
    signatureField.element,
    bioField.element,
    el('div', { className: 'acc-grid2' }, [
      genderField.element,
      birthdayField.element,
      regionField.element,
    ]),
  );

  /* -------------------------------------------------------------------------
     sync
  ------------------------------------------------------------------------- */

  const paintAvatar = (data: MyProfile): void => {
    avatarPreview.replaceChildren(
      createAvatar({ nickname: data.user.nickname, avatarUrl: data.user.avatarUrl, size: 'lg' }),
    );
    avatarRemove.disabled = !data.user.avatarUrl;
  };

  return {
    element: base.element,
    sync(data: MyProfile): void {
      paintAvatar(data);

      // 全部从 draft 渲染——draft 就是「用户眼前这份表单」，服务端的新数据由
      // `settings-tab` 在「没有未保存改动」时灌进 draft，再走到这里。
      const draft = hub.draft();
      nicknameInput.value = draft.nickname;
      emailInput.value = draft.email;
      syncPasswordRow();
      signatureInput.value = draft.signature;
      signatureField.setCount(charCount(draft.signature));
      bioArea.value = draft.bio;
      bioField.setCount(charCount(draft.bio));
      genderSelect.value = draft.gender;
      birthdayInput.value = draft.birthday;
      regionInput.value = draft.region;
    },
  };
}
