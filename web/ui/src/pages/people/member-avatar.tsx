import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "../presentation/i18n";
import {Avatar, AvatarBadge, AvatarFallback, AvatarImage, usePartnerAvatarDataUri, AvvvatarsFallbackContent} from '../../app/index';
import {memberDisplayName as roomMemberDisplayName,memberAvatarSeed as partnerAvatarSeedForMember,type MemberIdentity} from './identity';

export function RoomMemberAvatar(props: {
  member?: MemberIdentity;
  name?: string;
  seed?: string;
  status?: string;
  color?: string;
  className?: string;
  showStatus?: boolean;
}) {
  const { t } = useI18n();
  const name = props.name || (props.member ? roomMemberDisplayName(props.member) : "");
  const status = props.status || props.member?.status || "idle";
  const color = props.color || props.member?.color || "#64748b";
  const avatarMode = props.member?.avatarMode ?? (props.member?.avatarDataUrl ? "upload" : "generated");
  const avatarDataUrl = props.member?.avatarDataUrl;
  const avatarWasManuallyGenerated =
    avatarMode === "generated" &&
    Boolean(
      props.member?.avatarSeed?.trim() ||
        props.member?.userOverrides?.some((field) => field === "avatarMode" || field === "avatarSeed"),
    );
  const hasAppAvatar = Boolean(props.member?.generatedAvatar);
  const identity = props.member ? partnerAvatarSeedForMember(props.member) : props.seed || name || "member";
  const generatedIdentity = props.member?.avatarSeed?.trim() || identity;
  const initialsIdentity = name.trim() || identity;
  const [customAvatarFailed, setCustomAvatarFailed] = useState(false);
  const showCustomAvatar = Boolean(avatarMode === "upload" && avatarDataUrl && !customAvatarFailed);
  const useIdentityMark = !showCustomAvatar && !!props.member?.avatarMark;
  const shouldGeneratePartnerAvatar =
    !useIdentityMark &&
    avatarMode !== "initials" &&
    (!avatarDataUrl || customAvatarFailed || avatarMode === "generated") &&
    props.member?.source !== "human" &&
    (hasAppAvatar || avatarWasManuallyGenerated);
  const generatedPartnerAvatar = usePartnerAvatarDataUri(generatedIdentity, shouldGeneratePartnerAvatar);
  const imageSource = showCustomAvatar ? avatarDataUrl : generatedPartnerAvatar;
  const showRunningStatus = props.showStatus !== false && status === "running";
  const className = [
    "rooms-avatar",
    useIdentityMark ? props.member?.avatarMarkClassName : "",
    props.className,
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => setCustomAvatarFailed(false), [avatarDataUrl]);

  return (
    <Avatar
      className={className}
      data-status={showRunningStatus ? "running" : undefined}
      role="img"
      aria-label={name}
      style={{ "--room-avatar-color": color } as CSSProperties}
    >
      {imageSource ? (
        <AvatarImage
          key={imageSource}
          src={imageSource}
          alt=""
          onLoadingStatusChange={(loadingStatus) => {
            if (loadingStatus === "error" && showCustomAvatar) {
              setCustomAvatarFailed(true);
            }
          }}
        />
      ) : null}
      <AvatarFallback>
        {useIdentityMark ? props.member?.avatarMark : (
          <AvvvatarsFallbackContent value={initialsIdentity} displayValue={name || "?"} initialSize={40} />
        )}
      </AvatarFallback>
      {showRunningStatus ? <AvatarBadge role="status" aria-label={t("rooms.membersRunning", { names: name })} /> : null}
    </Avatar>
  );
}
