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
  {
    key: "useGitCreationTime",
    type: "boolean",
    default: true,
    title: "是否使用 Git 创建时间",
    description: "是否使用 Git 创建时间",
  },
  {
    key: "ignorePages",
    type: "string",
    default: "",
    title: "忽略的页面",
    description: "忽略的页面，用逗号分隔",
  },
  {
    key: "forceUpdateCreatedTime",
    type: "boolean",
    default: false,
    title: "强制更新创建时间",
    description: "开启时，如果发现已存在的 created 时间与 Git 时间不一致，将强制更新覆盖它。",
  },
  {
    key: "checkOnPageLoad",
    type: "boolean",
    default: false,
    title: "切换页面时自动检查",
    description: "开启后，每次进入页面时都会自动执行日期检查和更新（无需修改页面内容）。",
  },
];
