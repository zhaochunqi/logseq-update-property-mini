import { SettingSchemaDesc } from "@logseq/libs/dist/LSPlugin";

export const settingSchema: Array<SettingSchemaDesc> = [
  {
    key: "createTimePropertyName",
    type: "string",
    default: "created",
    title: "页面创建时间的属性名",
    description: "页面创建时间的属性名，默认是`created`",
  },
  {
    key: "updateTimePropertyName",
    type: "string",
    default: "updated",
    title: "页面更新时间的属性名",
    description: "页面更新时间的属性名，默认是`updated`",
  },
];
