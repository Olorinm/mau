import {useState,type ReactNode} from "react";
import {UserPlus} from "lucide-react";
import {ProductIcon,Tooltip,EmptyState,Dialog,DialogContent,DialogTitle} from "@olorinm/agent-ui/app";
import {useI18n} from "../presentation/i18n";
import {useCompactDetail,CompactBackButton} from "../layouts/compact-list-detail";
import {MotionMenu,MotionMenuItem} from "../ui/menu";
import {RemoteAgentMenuItem,type NetworkConfiguration} from "./remote-agent-menu-item";
import {RoomMemberAvatar} from "./member-avatar";
import {RoomMemberName} from "./member-name";
import {memberDisplayName,type MemberIdentity} from "./identity";
export function Contacts(props:{members:MemberIdentity[];selectedId?:string;section?:"employees"|"groups";groups?:{id:string;title:string;memberCount:number;badge?:string}[];detail?:ReactNode;dialogs?:ReactNode;networkConfiguration?:NetworkConfiguration;onSelectMember(id:string):void;onOpenMessages(id?:string):void;onAddLocal?():void;onAddRemote?():void}){
 const {t}=useI18n();const [createMenuOpen,setCreateMenuOpen]=useState(false);const [query,setQuery]=useState("");
 const [detailId,setDetailId]=useState<string>();const compactDetail=useCompactDetail(detailId,()=>setDetailId(undefined));
 const contactMembers=props.members;const filteredMembers=contactMembers.filter(m=>memberDisplayName(m).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));const groupRooms=props.groups??[];
 const selectMember=(id:string)=>{setDetailId(id);props.onSelectMember(id)};
 return (    <section
      className={`contacts-view ${compactDetail.className}`}
      aria-label={t("contacts.viewLabel")}
      data-list-detail={compactDetail.compact ? "compact" : "wide"}
      data-detail-open={String(compactDetail.detailOpen)}
    >
      <aside
        ref={compactDetail.listRef}
        onClickCapture={compactDetail.rememberListTarget}
        onFocusCapture={compactDetail.rememberListTarget}
        className="contacts-nav-panel"
        data-list-panel
        inert={compactDetail.compact && compactDetail.detailOpen}
      >
        <header className="contacts-nav-header">
          <h1>{t("contacts.messages")}</h1>
          <MotionMenu
            open={createMenuOpen}
            onOpenChange={setCreateMenuOpen}
            ariaLabel={t("rooms.createNew")}
            align="end"
            tooltipContent={t("rooms.createNew")}
            tooltipSide="bottom"
            trigger={
              <button
                className="rooms-icon-button"
                type="button"
                data-room-action="contacts-create-menu"
                aria-label={t("rooms.createNew")}
              >
                <ProductIcon name="add" size={16} />
              </button>
            }
          >
            <MotionMenuItem
              data-room-action="add-employee"
              disabled={!props.onAddLocal}
              onClick={() => {
                setCreateMenuOpen(false);
                props.onAddLocal?.();
              }}
            >
              <UserPlus size={17} />
              <span>{t("remoteAgent.addLocal")}</span>
            </MotionMenuItem>
            {props.onAddRemote ? <RemoteAgentMenuItem
              configuration={props.networkConfiguration ?? {status:"unconfigured",retry:()=>{}}}
              onSelect={() => {
                setCreateMenuOpen(false);
                props.onAddRemote?.();
              }}
            /> : null}
          </MotionMenu>
        </header>
        <nav className="collaboration-switch" aria-label={t("contacts.messageViews")}>
          <button type="button" data-room-view-target="rooms" onClick={() => props.onOpenMessages()}>
            {t("contacts.conversations")}
          </button>
          <button type="button" data-active="true" data-room-view-target="contacts">
            {t("contacts.viewLabel")}
          </button>
        </nav>
        <div className="rooms-search-wrap contacts-nav-search-wrap" data-open={query.trim() ? "true" : "false"}>
          <label className="rooms-search contacts-nav-search">
            <ProductIcon name="search" size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("contacts.searchPlaceholder")}
            />
            {query.trim() ? (
              <Tooltip content={t("contacts.clearSearch")}>
                <button
                  className="rooms-search-clear"
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label={t("contacts.clearSearch")}
                >
                  <ProductIcon name="close" size={15} />
                </button>
              </Tooltip>
            ) : null}
          </label>
        </div>
        <section className="contacts-sidebar-directory" aria-label={t("contacts.employeeList")}>
          <div className="rooms-section-label contacts-nav-section-label">
            <span>{t("app.rooms")}</span>
            <small>{t("contacts.employeeCount", { count: contactMembers.length })}</small>
          </div>
          <div className="contacts-list contacts-sidebar-member-list">
            {filteredMembers.map((member) => (
              <button
                key={member.id}
                className="contacts-person-row"
                data-active={props.selectedId === member.id ? "true" : "false"}
                type="button"
                onClick={() => selectMember(member.id)}
              >
                <RoomMemberAvatar member={member} />
                <span>
                  <strong>
                    <RoomMemberName member={member} />
                  </strong>
                </span>
              </button>
            ))}
            {!filteredMembers.length ? (
              <div className="rooms-empty-row">{t("contacts.noMatchingEmployees")}</div>
            ) : null}
          </div>
        </section>
      </aside>

      <main
        className="contacts-main-panel"
        ref={compactDetail.detailRef}
        data-detail-panel
        inert={compactDetail.compact && !compactDetail.detailOpen}
      >
        {compactDetail.compact ? (
          <CompactBackButton label={t("compact.employees")} onClick={compactDetail.showList} />
        ) : null}
        {props.section !== "groups" ? (
          <div className="contacts-detail-layout">
            <section
              className="contacts-detail-panel contacts-employee-detail"
              aria-label={t("contacts.employeeProfile")}
            >
              {props.selectedId ? (
                props.detail
              ) : (
                <div className="rooms-empty-row">{t("contacts.selectEmployeeHint")}</div>
              )}
            </section>
          </div>
        ) : (
          <section className="contacts-group-list" aria-label={t("ops.sourceRooms")}>
            {groupRooms.map((room) => (
              <button
                className="contacts-group-row"
                key={room.id}
                type="button"
                onClick={() => props.onOpenMessages(room.id)}
              >
                <span className="contacts-group-icon" aria-hidden="true">
                  <ProductIcon name="rooms" size={18} />
                </span>
                <div>
                  <strong>{room.title}</strong>
                  <small>
                    {t("mountedApp.groupMemberCount", { count: room.memberCount })} · {room.badge}
                  </small>
                </div>
              </button>
            ))}
            {!groupRooms.length ? <EmptyState compact title={t("contacts.noGroupRooms")} /> : null}
          </section>
        )}
      </main>

      {props.dialogs}
    </section>);}

export function EmployeeDeleteDialog(props:{open:boolean;name:string;pending?:boolean;error?:string;onOpenChange(value:boolean):void;onDelete():void}){const {t}=useI18n();return (        <Dialog open={props.open} onOpenChange={open=>{if(!props.pending)props.onOpenChange(open)}}>
          <DialogContent className="contacts-confirm-dialog" aria-label={t("contacts.deleteEmployeeTitle")}>
            <DialogTitle>{t("contacts.deleteEmployeeTitle")}</DialogTitle>
            <p className="contacts-confirm-copy">
              {t("contacts.deleteEmployeeConfirm", { name: props.name })}
            </p>
            {props.error ? <p role="alert">{props.error}</p> : null}
            <div className="modal-actions">
              <button className="ghost-button" type="button" disabled={props.pending} onClick={() => props.onOpenChange(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={props.pending}
                onClick={props.onDelete}
              >
                {t("common.delete")}
              </button>
            </div>
          </DialogContent>
        </Dialog>);}
