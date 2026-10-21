import { AvatarGroup, AvatarGroupCount } from "@olorinm/agent-ui/app";
import type {ReactNode} from "react";
import { ProductIcon } from "@olorinm/agent-ui/app";
import { RoomMemberAvatar } from "./member-avatar";
import type {MemberIdentity as RoomMember} from "./identity";


export function RoomGroupAvatar(props: { title: string; className: string; members?: RoomMember[]; avatarMark?: ReactNode; avatarMarkClassName?: string }) {
  const useGroveMark = !!props.avatarMark;
  const visibleMembers = (props.members ?? []).filter((member) => !member.disabled);
  const stackedMembers = visibleMembers.slice(0, 3);
  const hiddenMemberCount = Math.max(0, visibleMembers.length - stackedMembers.length);
  const stackItemCount = stackedMembers.length + (hiddenMemberCount > 0 ? 1 : 0);
  const useMemberStack = !useGroveMark && stackedMembers.length >= 2;
  const className = [
    props.className,
    "room-group-avatar",
    useGroveMark ? props.avatarMarkClassName : "",
    useMemberStack ? "has-members" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={className}
      data-member-count={useMemberStack ? visibleMembers.length : undefined}
      aria-hidden="true"
    >
      {useGroveMark ? (
        props.avatarMark
      ) : useMemberStack ? (
        <AvatarGroup className="room-group-avatar-stack" data-stack-item-count={stackItemCount}>
          {stackedMembers.map((member) => (
            <RoomMemberAvatar key={member.id} member={member} className="room-group-avatar-member" showStatus={false} />
          ))}
          {hiddenMemberCount > 0 ? (
            <AvatarGroupCount className="room-group-avatar-count">+{hiddenMemberCount}</AvatarGroupCount>
          ) : null}
        </AvatarGroup>
      ) : (
        <ProductIcon name="rooms" />
      )}
    </span>
  );
}
