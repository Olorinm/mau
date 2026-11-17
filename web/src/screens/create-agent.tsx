import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ProfileDialog } from "@olorinm/agent-ui/pages";
import { Button, PartnerAvatar } from "@olorinm/agent-ui/app";
import { mauApi } from "../api/client";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";

// Same rule as Mau's POST /agents schema.
const namePattern = /^[a-z][a-z0-9-]{0,47}$/;

export function CreateAgentDialog(props: {
  session: Session;
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
  const [chosen, setChosen] = useState<string | null>(null);
  const profiles = options.data?.environments ?? [];
  const profileId = chosen ?? (profiles.length === 1 ? profiles[0]!.id : null);
  const create = useMutation({
    mutationFn: () => api.createAgent(name, profileId!),
    onSuccess: (summary) => props.onCreated(summary.agent.id),
  });
  const valid = namePattern.test(name) && !!profileId;
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
            </>
          ),
        },
        {
          id: "runtime",
          label: t("env.title"),
          className: "partner-dialog-runtime-card",
          content: (
            <section className="partner-dialog-runtime">
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
            </section>
          ),
        },
      ]}
      feedback={
        create.error ? (
          <p className="partner-dialog-submit-error" role="alert">
            {errorMessage(
              t,
              create.error instanceof ApiError
                ? create.error.code
                : "request_failed",
            )}
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
