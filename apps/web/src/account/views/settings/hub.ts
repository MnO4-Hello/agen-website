/**
 * 设置页的六个面板共用的「中枢」。
 *
 * 面板不持有数据，只负责画控件、把改动通过 `patch()` 写回唯一的那份 draft。
 * 这样「脏状态」「保存」「离开前拦截」都只需要在 `settings-tab.ts` 里做一次，
 * 而不是六个面板各做一遍（做两遍就会有两套不一样的行为）。
 */

import type { PublicUser } from '../../../auth/api';
import type { StatusTone } from '../../pieces';
import type {
  CustomBadge,
  MyProfile,
  ProfileData,
  ProfileVisibility,
  SocialLink,
  SystemBadge,
} from '../../types';

/**
 * 可保存的字段。
 *
 * **不含三个媒体 URL**：它们只能由上传接口写。把封面 URL 放进 draft 会有两个后果——
 * 一次保存把刚上传的新封面用旧值覆盖回去；以及「上传完 → 草稿变脏 → 用户以为还得再点保存」。
 */
export interface Draft {
  nickname: string;
  email: string;
  signature: string;
  bio: string;
  gender: ProfileData['gender'];
  birthday: string;
  region: string;
  socials: SocialLink[];
  tags: string[];
  badges: CustomBadge[];
  theme: ProfileData['theme'];
  visibility: ProfileVisibility;
  privacy: ProfileData['privacy'];
  customCss: string;
}

export function draftOf(data: MyProfile): Draft {
  const p = data.profile;
  return {
    nickname: data.user.nickname,
    email: data.user.email,
    signature: p.signature,
    bio: p.bio,
    gender: p.gender,
    birthday: p.birthday,
    region: p.region,
    socials: p.socials.map((link) => ({ ...link })),
    tags: [...p.tags],
    badges: p.badges.map((badge) => ({ ...badge })),
    theme: { ...p.theme },
    visibility: p.visibility,
    privacy: { ...p.privacy },
    customCss: p.customCss,
  };
}

export interface SettingsHub {
  /** 当前 draft。**不要缓存引用**：每次 patch 之后都是新对象。 */
  draft(): Draft;
  user(): PublicUser;
  meta(): MyProfile['meta'];
  systemBadges(): SystemBadge[];
  /** 封面 / 背景这类「显示用」的 URL 不在 draft 里（见 `Draft` 的说明）。 */
  media(): { coverUrl: string; backgroundUrl: string };
  /** 改 draft 并标脏。 */
  patch(partial: Partial<Draft>): void;
  status(text: string, tone?: StatusTone): void;
  /**
   * 上传/删除媒体成功后调用。
   *
   * 传的是**完整资料**——媒体 URL 不在 draft 里，所以这一步不会把 draft 弄脏；
   * 同时会通知外面刷新页头与「我的主页」预览。
   */
  adoptMedia(data: MyProfile): void;
}

/** 六个面板的统一契约：`sync` 只写「用户没碰过」的控件。 */
export interface SettingsPanel {
  readonly element: HTMLElement;
  sync(data: MyProfile): void;
  dispose?(): void;
}
