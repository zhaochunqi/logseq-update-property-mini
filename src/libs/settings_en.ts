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
];
