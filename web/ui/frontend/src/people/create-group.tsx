import { Dialog, DialogContent, DialogTitle, ProductIcon } from "@olorinm/agent-ui/app";
import { useI18n } from "../presentation/i18n";
import { RoomGroupAvatar } from "./group-avatar";
import { RoomMemberAvatar } from "./member-avatar";
import { RoomMemberName } from "./member-name";
import type { MemberIdentity as RoomMember } from "./identity";
import "../styles/room-dialogs.css";

// Presentation restored from OpenGrove rooms-view-layout.tsx (CreateGroupDialog / CreateGroupForm);
// caller owns the selected members and the create operation.
export type CreateGroupDialogProps = {
  open: boolean;
  title: string;
  selectedMemberIds: string[];
  contactMembers: RoomMember[];
  busy?: boolean;
  onOpenChange(open: boolean): void;
  onTitleChange(value: string): void;
  onToggleMember(memberId: string): void;
  onCreate(): void;
};

export function CreateGroupDialog(props: CreateGroupDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="rooms-create-group-dialog" aria-label={t("rooms.createGroup")}>
        <DialogTitle>{t("rooms.createGroup")}</DialogTitle>
        <CreateGroupForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

export function CreateGroupForm(props: CreateGroupDialogProps) {
  const { t } = useI18n();
  const selectedMembers = props.contactMembers.filter((member) => props.selectedMemberIds.includes(member.id));
  return (
    <>
      <div className="rooms-create-group-hero">
        <RoomGroupAvatar
          title={props.title || t("rooms.createGroup")}
          className="rooms-create-group-avatar"
          members={selectedMembers}
        />
        <strong>{props.title.trim() || t("rooms.createGroup")}</strong>
      </div>
      <section className="rooms-create-group-section">
        <h3>{t("rooms.groupNameLabel")}</h3>
        <label className="rooms-create-group-name">
          <span>{t("rooms.groupNameLabel")}</span>
          <input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} />
        </label>
      </section>
      <section className="rooms-create-group-members">
        <div className="rooms-create-group-title">
          <strong>{t("rooms.chooseEmployees")}</strong>
          <span>
            {props.selectedMemberIds.length} / {props.contactMembers.length}
          </span>
        </div>
        <div className="rooms-create-group-list">
          {props.contactMembers.length ? (
            props.contactMembers.map((member) => (
              <label className="rooms-create-group-member" key={member.id}>
                <input
                  type="checkbox"
                  checked={props.selectedMemberIds.includes(member.id)}
                  onChange={() => props.onToggleMember(member.id)}
                />
                <RoomMemberAvatar member={member} />
                <span className="rooms-create-group-member-name">
                  <strong>
                    <RoomMemberName member={member} />
                  </strong>
                </span>
                <ProductIcon name="success" size={18} />
              </label>
            ))
          ) : (
            <div className="rooms-empty-row">{t("rooms.noEmployeesRecruitFirst")}</div>
          )}
        </div>
      </section>
      <div className="modal-actions">
        <button className="ghost-button" type="button" onClick={() => props.onOpenChange(false)}>
          {t("common.cancel")}
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={props.onCreate}
          disabled={props.busy || !props.selectedMemberIds.length}
        >
          {t("mountedApp.create")}
        </button>
      </div>
    </>
  );
}
