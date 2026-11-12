import type { ReactNode } from 'react';
export type MemberAvatarMode = 'generated' | 'initials' | 'upload';
/** Display identity only. Account ownership, membership and model selection remain caller-owned. */
export interface MemberIdentity {
  id: string;
  employeeDefinitionId?: string;
  name: string;
  displayName?: string;
  userOverrides?: string[];
  status?: string;
  color?: string;
  avatarMode?: MemberAvatarMode;
  avatarSeed?: string;
  avatarDataUrl?: string;
  avatarMark?: ReactNode;
  avatarMarkClassName?: string;
  generatedAvatar?: boolean;
  source?: string;
  detail?: string;
  disabled?: boolean;
  owner?: boolean;
}
export function memberDisplayName(member: Pick<MemberIdentity,'name'|'displayName'|'userOverrides'>): string {
  if(member.userOverrides?.includes('name')) return member.name;
  return member.displayName?.trim() || member.name;
}
export function memberAvatarSeed(member: Pick<MemberIdentity,'id'|'employeeDefinitionId'>): string {
  return member.employeeDefinitionId?.trim() || member.id.trim() || 'employee';
}
export interface GroupIdentity {
  id: string;
  title: string;
  kind: 'group' | 'direct';
  memberIds: string[];
  adminMemberIds: string[];
  pinned?: boolean;
  avatarMark?: ReactNode;
  avatarMarkClassName?: string;
}
