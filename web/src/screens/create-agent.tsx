import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Dialog, DialogContent, DialogTitle } from "@olorinm/agent-ui/app";
import { mauApi } from "../api/client";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";

// Same rule as Mau's POST /agents schema.
const namePattern = /^[a-z][a-z0-9-]{0,47}$/;

export function CreateAgentDialog(props: { session: Session; onClose(): void; onCreated(agentId: string): void }) {
  const { t } = useI18n();
  const api = mauApi(props.session.token);
  const options = useQuery({ queryKey: ["options", props.session.owner], queryFn: api.options });
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
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="mau-dialog" aria-describedby={undefined}>
        <DialogTitle>{t("create.title")}</DialogTitle>
        <form className="mau-form" onSubmit={submit}>
          <label className="mau-field">
            <span>{t("create.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoCapitalize="none"
              spellCheck={false} maxLength={48} aria-invalid={name !== "" && !namePattern.test(name)} autoFocus />
            <small>{t("create.nameHint")}</small>
          </label>
          <fieldset className="mau-field">
            <legend>{t("create.profile")}</legend>
            {options.isPending ? <small>{t("common.loading")}</small> : null}
            {options.isSuccess && !profiles.length ? <p className="mau-muted">{t("create.noProfiles")}</p> : null}
            {profiles.map((profile) => (
              <label key={profile.id} className="mau-choice">
                <input type="radio" name="profile" value={profile.id} checked={profileId === profile.id}
                  onChange={() => setChosen(profile.id)} />
                <span>
                  <strong>{profile.label}</strong>
                  <small>{profile.kernel}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {create.error ? (
            <p className="mau-error" role="alert">
              {errorMessage(t, create.error instanceof ApiError ? create.error.code : "request_failed")}
            </p>
          ) : null}
          <div className="modal-actions">
            <Button onClick={props.onClose}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!valid || create.isPending}>
              {create.isPending ? t("common.loading") : t("create.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
