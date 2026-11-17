import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ProfileDialog } from "@olorinm/agent-ui/pages";
import { Button, ListRow, PartnerAvatar, SegmentedControl, SelectMenu, SettingsSection } from "@olorinm/agent-ui/app";
import { canShareEnvironment, mauApi, type AgentSummary } from "../api/client";
import type { Session } from "../api/session";
import { failureMessage, useI18n } from "../i18n";

// Same rules as Mau's POST /agents schema: the name, and a duty of one line of at most 200 characters.
const namePattern = /^[a-z][a-z0-9-]{0,47}$/;
const dutyLimit = 200;
const lineBreaks = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
type EnvironmentKind = "own" | "shared";

export function CreateAgentDialog(props: {
  session: Session;
  /** The owner's partners; a new one can run in the environment of those that have their own. */
  partners: readonly AgentSummary[];
  onClose(): void;
  onCreated(agentId: string): void;
}) {
  const { t, language } = useI18n();
  const api = mauApi(props.session.token);
  const options = useQuery({
    queryKey: ["options", props.session.owner],
    queryFn: api.options,
  });
  const [name, setName] = useState("");
  const [duty, setDuty] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const profiles = options.data?.environments ?? [];
  const profileId = chosen ?? (profiles.length === 1 ? profiles[0]!.id : null);
  // An environment of its own unless the owner chooses to share one; sharing is all there is without a profile.
  const hosts = props.partners.filter(canShareEnvironment);
  const [kind, setKind] = useState<EnvironmentKind>();
  const shared = hosts.length > 0 && (kind ?? (options.isSuccess && !profiles.length ? "shared" : "own")) === "shared";
  // With several partners to share with, the owner picks one; nothing is preselected.
  const [partner, setPartner] = useState<string | null>(null);
  const shareWith = hosts.some(({ agent }) => agent.id === partner) ? partner : hosts.length === 1 ? hosts[0]!.agent.id : null;
  const environment = shared ? (shareWith ? { shareWith } : null) : profileId ? { profileId } : null;
  const create = useMutation({
    mutationFn: () => api.createAgent(name, environment!, duty.trim()),
    onSuccess: (summary) => props.onCreated(summary.agent.id),
  });
  const valid = namePattern.test(name) && !!environment;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !create.isPending) create.mutate();
  };
  return (
    <ProfileDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={t("create.title")}
      onSubmit={submit}
      tabs={[
        {
          id: "profile",
          label: language === "zh-CN" ? "基本资料" : "Profile",
          className: "partner-dialog-identity-card",
          content: (
            <>
              <div className="partner-dialog-profile-hero">
                <PartnerAvatar
                  seed={name || "new-agent"}
                  fallbackName={name || "Agent"}
                  size={80}
                />
              </div>
              <label className="partner-dialog-field partner-dialog-profile-name-row">
                <span>{t("create.name")}</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={48}
                  aria-invalid={name !== "" && !namePattern.test(name)}
                />
                <small>{t("create.nameHint")}</small>
              </label>
              <label className="partner-dialog-field partner-dialog-profile-name-row">
                <span>{t("create.duty")}</span>
                <input
                  value={duty}
                  onChange={(e) => setDuty(e.target.value.replace(lineBreaks, " "))}
                  autoComplete="off"
                  maxLength={dutyLimit}
                />
                <small>{duty.length} / {dutyLimit}</small>
              </label>
            </>
          ),
        },
        {
          id: "runtime",
          label: t("env.title"),
          className: "partner-dialog-runtime-card",
          content: (
            <section className="partner-dialog-runtime">
              <SegmentedControl<EnvironmentKind>
                label={t("create.environment")}
                value={shared ? "shared" : "own"}
                onChange={setKind}
                options={[
                  { value: "own", label: t("create.ownEnvironment") },
                  { value: "shared", label: t("create.sharedEnvironment"), disabled: !hosts.length },
                ]}
              />
              {shared ? (
                <SettingsSection>
                  <ListRow
                    title={t("create.sharePartner")}
                    trailing={
                      <SelectMenu
                        label={t("create.sharePartner")}
                        placeholder={t("create.choosePartner")}
                        value={shareWith}
                        onChange={setPartner}
                        options={hosts.map(({ agent }) => ({ value: agent.id, label: agent.name }))}
                      />
                    }
                  />
                </SettingsSection>
              ) : (
                <>
                  <h3 className="partner-dialog-runtime-title">
                    {t("create.profile")}
                  </h3>
                  {options.isPending ? <p>{t("common.loading")}</p> : null}
                  {options.isSuccess && !profiles.length ? (
                    <p>{t("create.noProfiles")}</p>
                  ) : null}
                  <div className="partner-dialog-kernel-list">
                    {profiles.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        className="partner-dialog-kernel-option"
                        aria-pressed={profileId === profile.id}
                        data-active={profileId === profile.id}
                        onClick={() => setChosen(profile.id)}
                      >
                        <strong>{profile.label}</strong>
                        <small>{profile.kernel}</small>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>
          ),
        },
      ]}
      feedback={
        create.error ? (
          <p className="partner-dialog-submit-error" role="alert">
            {failureMessage(t, create.error)}
          </p>
        ) : null
      }
      actions={
        <>
          <Button onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!valid || create.isPending}
          >
            {create.isPending ? t("common.loading") : t("create.submit")}
          </Button>
        </>
      }
    />
  );
}
