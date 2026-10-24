/**
 * 个人中心的前端形状，逐字镜像服务端的 `users/profile-types.ts`。
 *
 * 为什么抄一份而不共享：两个 workspace 没有共享的类型包（`apps/web` 不能 import
 * `apps/api/src`，那会把 Node 端的类型与运行时代码拖进浏览器产物）。所以这份要
 * 跟着服务端一起改——好在它只包含数据形状，没有逻辑。
 */

import type { PublicUser, Role } from '../auth/api';

export type PrivacyLevel = 'public' | 'self' | 'hidden';
export type Gender = 'male' | 'female' | 'other' | 'none';
export type ProfileVisibility = 'public' | 'members' | 'private';

export const PROFILE_FIELDS = [
  'signature',
  'bio',
  'gender',
  'birthday',
  'region',
  'socials',
  'tags',
  'badges',
  'lastLogin',
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type PrivacySettings = Record<ProfileField, PrivacyLevel>;

export interface SocialLink {
  id: string;
  label: string;
  url: string;
}

export interface CustomBadge {
  id: string;
  label: string;
  color: string;
  emoji: string;
}

export interface ProfileTheme {
  accent: string;
  accentStrong: string;
  surface: string;
  text: string;
}

export interface ProfileData {
  version: 1;
  signature: string;
  bio: string;
  gender: Gender;
  birthday: string;
  region: string;
  socials: SocialLink[];
  tags: string[];
  badges: CustomBadge[];
  theme: ProfileTheme;
  coverUrl: string;
  backgroundUrl: string;
  customCss: string;
  visibility: ProfileVisibility;
  privacy: PrivacySettings;
}

export type SystemBadgeId = 'role-owner' | 'role-admin' | 'year' | 'early';

export interface SystemBadge {
  id: SystemBadgeId;
  kind: 'system';
  label: string;
  color: string;
  emoji: string;
  hint: string;
}

export interface MyProfile {
  user: PublicUser;
  profile: ProfileData;
  meta: { lastLoginAt: string | null; updatedAt: string };
  systemBadges: SystemBadge[];
}

export interface PublicProfile {
  username: string;
  nickname: string;
  avatarUrl: string;
  role: Role;
  createdAt: string;
  isSelf: boolean;
  visibility: ProfileVisibility;
  coverUrl: string;
  backgroundUrl: string;
  theme: ProfileTheme;
  signature: string | null;
  bio: string | null;
  gender: Gender | null;
  birthday: string | null;
  region: string | null;
  lastLoginAt: string | null;
  socials: SocialLink[] | null;
  tags: string[] | null;
  customBadges: CustomBadge[] | null;
  systemBadges: SystemBadge[];
  stats: { days: number; badges: number; tags: number };
}

/** 与服务端 `PROFILE_LIMITS` 一致；界面上直接用这些数字写「还可以输几个字」。 */
export const LIMITS = {
  signature: 40,
  bio: 300,
  region: 32,
  tagLength: 16,
  tagCount: 8,
  linkCount: 6,
  linkLabel: 16,
  linkUrl: 300,
  badgeCount: 12,
  badgeLabel: 12,
  badgeEmoji: 8,
  cssBytes: 8192,
} as const;

export const DEFAULT_THEME: ProfileTheme = {
  accent: '#3f7d58',
  accentStrong: '#2f6244',
  surface: '#f2f7f0',
  text: '#1f3d2b',
};

/**
 * 主题预设。
 *
 * 只给四个变量填值——自定义 CSS 再怎么写也绕不过「页面底色由主题控制」这条，
 * 否则一个把 `body` 写成黑色的用户会把自己整站搞废（见 `css-scope.ts`）。
 */
export const THEME_PRESETS: readonly { id: string; label: string; theme: ProfileTheme }[] = [
  { id: 'default', label: '苔绿', theme: { accent: '#3f7d58', accentStrong: '#2f6244', surface: '#f2f7f0', text: '#1f3d2b' } },
  { id: 'clay', label: '陶土', theme: { accent: '#a4553c', accentStrong: '#7f3f2c', surface: '#faf3ee', text: '#3b2620' } },
  { id: 'indigo', label: '靛蓝', theme: { accent: '#3f5f8a', accentStrong: '#2e4a6e', surface: '#eef2f8', text: '#1c2a3d' } },
  { id: 'plum', label: '梅紫', theme: { accent: '#6b5a8a', accentStrong: '#53456e', surface: '#f4f1f8', text: '#2b2438' } },
  { id: 'sand', label: '沙金', theme: { accent: '#8a7440', accentStrong: '#6d5a2f', surface: '#f8f5ea', text: '#33301f' } },
  { id: 'graphite', label: '石墨', theme: { accent: '#4a5158', accentStrong: '#33383d', surface: '#f1f2f3', text: '#20242a' } },
];
