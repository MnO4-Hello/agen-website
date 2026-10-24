/**
 * 设置 · 账号安全（改密码）
 *
 * 这一块**完全独立于 draft**：密码不参与「保存 / 脏状态」，改完立刻生效。
 * 混进 draft 会有两个坏处——用户改了密码却没点保存就走了、以及「保存成功」的
 * 提示分不清是资料还是密码。
 */

import { SECURITY_COPY } from '../../../content/account';
import { changePassword } from '../../api';
import { accBlock, accButton, accField, accInput, accStatus, el } from '../../pieces';
import type { MyProfile } from '../../types';
import type { SettingsHub, SettingsPanel } from './hub';

export function createSecurityPanel(_hub: SettingsHub): SettingsPanel {
  const status = accStatus();

  const currentInput = accInput({ value: '', type: 'password', autocomplete: 'current-password' });
  const currentField = accField({ label: SECURITY_COPY.current, control: currentInput });

  const nextInput = accInput({ value: '', type: 'password', autocomplete: 'new-password' });
  const nextField = accField({
    label: SECURITY_COPY.next,
    control: nextInput,
    hint: SECURITY_COPY.nextHint,
  });

  const confirmInput = accInput({ value: '', type: 'password', autocomplete: 'new-password' });
  const confirmField = accField({ label: SECURITY_COPY.confirm, control: confirmInput });

  const submit = accButton({
    label: SECURITY_COPY.submit,
    tone: 'primary',
    icon: 'shield',
    onClick: () => {
      void run();
    },
  });

  const block = accBlock({ title: SECURITY_COPY.title, note: SECURITY_COPY.note });
  block.body.append(
    currentField.element,
    nextField.element,
    confirmField.element,
    el('div', { className: 'acc-media__actions' }, [submit]),
    status.element,
  );

  const clearErrors = (): void => {
    currentField.setError(null);
    nextField.setError(null);
    confirmField.setError(null);
  };

  const run = async (): Promise<void> => {
    clearErrors();
    status.clear();

    const current = currentInput.value;
    const next = nextInput.value;
    const confirm = confirmInput.value;

    // 前端先跑一遍，省一次来回（服务端还会再跑一次，那才是权威）。
    if (!current) {
      currentField.setError('请输入当前密码。');
      currentInput.focus();
      return;
    }
    if (next.length < 8 || next.length > 16 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
      nextField.setError('新密码要 8–16 位，并且同时包含字母和数字。');
      nextInput.focus();
      return;
    }
    if (next !== confirm) {
      confirmField.setError('两次输入的新密码不一致。');
      confirmInput.focus();
      return;
    }
    if (next === current) {
      nextField.setError('新密码和旧密码一模一样。');
      nextInput.focus();
      return;
    }

    submit.disabled = true;
    status.set('正在更新…');
    const result = await changePassword({
      currentPassword: current,
      newPassword: next,
      confirmPassword: confirm,
    });
    submit.disabled = false;

    if (!result.ok) {
      if (result.field === 'currentPassword') currentField.setError(result.message);
      else if (result.field === 'newPassword') nextField.setError(result.message);
      else if (result.field === 'confirmPassword') confirmField.setError(result.message);
      status.set(result.message, 'error');
      return;
    }

    currentInput.value = '';
    nextInput.value = '';
    confirmInput.value = '';
    status.set('密码已更新。其他设备仍然登录着——这是有意的。', 'ok', 6000);
  };

  return {
    element: block.element,
    // 密码面板不消费资料数据。**不要在 sync 里清空输入**：保存资料时也会走 sync，
    // 那会把用户刚敲到一半的密码抹掉。换账号时视图整个重建，本来就是空的。
    sync(_data: MyProfile): void {},
  };
}
