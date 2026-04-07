import { SettingSchemaDesc } from "@logseq/libs/dist/LSPlugin";

export const englishSettingSchema: Array<SettingSchemaDesc> = [
  {
    key: "createTimePropertyName",
    type: "string",
    default: "created",
    title: "Page creation time property name",
    description: "Page creation time property name, default is `created`",
  },
  {
    key: "updateTimePropertyName",
    type: "string",
    default: "updated",
    title: "Page update time property name",
    description: "Page update time property name, default is `updated`",
  },
  {
    key: "useGitCreationTime",
    type: "boolean",
    default: true,
    title: "Use Git creation time",
    description: "Use Git creation time",
  },
  {
    key: "ignorePages",
    type: "string",
    default: "",
    title: "Ignore pages",
    description: "Ignore pages, separated by commas",
  },
  {
    key: "forceUpdateCreatedTime",
    type: "boolean",
    default: false,
    title: "Force update creation time",
    description: "When enabled, if the existing created time does not match Git time, it will force update and overwrite it.",
  },
  {
    key: "checkOnPageLoad",
    type: "boolean",
    default: false,
    title: "Check on page load",
    description: "When enabled, it will automatically check and update dates every time you navigate to a page (no block edit required).",
  },
];
