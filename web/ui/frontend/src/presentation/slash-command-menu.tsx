import { Command } from "cmdk";
import { Box } from "lucide-react";
export interface SlashSkillView {id:string;name:string;title:string;description?:string;sourceLabel:string}
export interface SlashCommandView {id:string;name:string;title:string;description:string;sourceLabel:string}
import { summarize } from "../process/format";
import { useI18n } from "../presentation/i18n";

import "../styles/skill-command-menu.css";

export function SlashCommandMenu(props: {
  commands: SlashCommandView[];
  skills: SlashSkillView[];
  activeIndex: number;
  onSelectCommand(command: SlashCommandView): void;
  onSelect(skill: SlashSkillView): void;
}) {
  const { t } = useI18n();
  const commandCount = props.commands.length;
  return (
    <Command shouldFilter={false}>
      <Command.List className="skill-menu-list">
        {props.commands.length ? (
          <Command.Group
            className="skill-menu-group"
            heading={<div className="skill-menu-heading">{t("chat.slashCommands")}</div>}
          >
            {props.commands.map((command, index) => (
              <Command.Item
                key={command.id}
                value={command.name}
                className="skill-menu-item"
                data-kind="command"
                data-selected={index === props.activeIndex ? "true" : "false"}
                onSelect={() => props.onSelectCommand(command)}
              >
                <div className="skill-menu-item-main">
                  <span className="skill-menu-item-title">
                    <span className="skill-menu-slash">/</span>
                    {command.name}
                  </span>
                  <span className="skill-menu-item-description">
                    {command.title} · {summarize(command.description, 118)}
                  </span>
                </div>
                <span className="skill-menu-item-source">
                  {command.sourceLabel}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {props.skills.length ? (
          <Command.Group
            className="skill-menu-group"
            heading={<div className="skill-menu-heading">{t("composer.skills")}</div>}
          >
            {props.skills.map((skill, index) => (
              <Command.Item
                key={skill.id || skill.name}
                value={skill.name || skill.id}
                className="skill-menu-item"
                data-kind="skill"
                data-selected={commandCount + index === props.activeIndex ? "true" : "false"}
                onSelect={() => props.onSelect(skill)}
              >
                <div className="skill-menu-item-icon" aria-hidden="true">
                  <Box size={14} />
                </div>
                <div className="skill-menu-item-main">
                  <span className="skill-menu-item-title">{skill.title}</span>
                  <span className="skill-menu-item-description">
                    {summarize(skill.description || t("chat.skillDefaultDescription"), 132)}
                  </span>
                </div>
                <span className="skill-menu-item-source">{skill.sourceLabel}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command>
  );
}
