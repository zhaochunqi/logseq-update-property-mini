import "@logseq/libs";

import { format } from "date-fns";

import "./index.css";
import { settingSchema } from "./libs/settings";
import { logseq as pluginInfo } from "../package.json";
import { englishSettingSchema } from "./libs/settings_en";
import {
  BlockEntity,
  IDatom,
  PageEntity,
  PageIdentity,
} from "@logseq/libs/dist/LSPlugin.user";
import { LRUCache } from "lru-cache";

const pluginId = pluginInfo.id;

interface Settings {
  createTimePropertyName: string;
  updateTimePropertyName: string;
  useGitCreationTime: boolean;
  ignorePages: string;
}

// 将 getGitFileCreationTime 函数提到全局作用域
async function getGitFileCreationTime(fileId: number) {
  // 使用 :find ?file . 语法直接返回单一值
  const filePathResult = await logseq.DB.datascriptQuery(
    `[:find ?file . :where [?b :file/path ?file] [(== ?b ${fileId})]]`
  );
  if (!filePathResult) throw new Error("file not found");

  const filePath = filePathResult;

  // 通过 git 命令来获取文件的创建时间
  const logseqGraphFolder = (await logseq.App.getCurrentGraph())?.path;
  if (!logseqGraphFolder) throw new Error("logseq graph folder not found");

  const gitCommand = [
    "-C",
    logseqGraphFolder,
    "log",
    "--diff-filter=A",
    "--format=%at",
    "--reverse",
    "--",
    filePath,
  ];

  const result = await (logseq.Git?.execCommand?.(gitCommand) ??
    Promise.reject(new Error("Git helper unavailable")));
  if (!result.stdout) throw new Error("cannot get git creation time");

  // verify the creation time is a number
  const creationTimeStr = result.stdout.trim();
  if (!/^\d+$/.test(creationTimeStr))
    throw new Error("invalid git creation timestamp");

  return Number(creationTimeStr) * 1000;
}

// 创建一个缓存对象来存储文件创建时间，避免重复查询
// LRUCache<fileId, creationTime>
const gitCreationTimeCache = new LRUCache<number, number>({
  max: 1000,
  ttl: 1000 * 60 * 60 * 24,
  fetchMethod: async (fileId) => {
    return await getGitFileCreationTime(fileId);
  },
});

/**
 * 初始化插件设置
 */
function initializeSettings() {
if (logseq.settings === undefined) {
     logseq.updateSettings({
       createTimePropertyName: "created",
       updateTimePropertyName: "updated",
      useGitCreationTime: true,
      ignorePages: "",
     });
   }
}

/**
 * 根据用户语言加载相应的设置模式
 */
async function loadSettingsSchema() {
  const { preferredLanguage } = await logseq.App.getUserConfigs();
  const schema =
    preferredLanguage === "zh-CN" ? settingSchema : englishSettingSchema;
  logseq.useSettingsSchema(schema);
}

/**
 * 获取页面创建时间
 * @param fileId 文件ID
 * @param useGitCreationTime 是否使用Git创建时间
 * @param fallbackTime 默认时间
 */
async function getPageCreationTime(
  fileId: number | undefined,
  useGitCreationTime: boolean,
  fallbackTime: number
): Promise<number> {
  if (!fileId) {
    return fallbackTime;
   } else if (useGitCreationTime) {
    return gitCreationTimeCache
      .fetch(fileId)
      .then((result) => result as number)
      .catch(() => fallbackTime);
  }
  return fallbackTime;
}

/**
 * 检查页面是否应该被忽略
 * @param page 页面对象
 * @param ignorePages 忽略页面列表字符串
 */
function shouldIgnorePage(page: PageEntity, ignorePages?: string): boolean {
  // 如果是日记页面，则忽略
  if (page?.["journal?"]) return true;

  // 检查是否在忽略列表中
  const ignorePagesList =
    ignorePages
      ?.split(",")
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 0) || [];

  if (ignorePagesList.includes(page.name.toLowerCase())) {
    console.log(`page: ${page.name} defined in ignorePages is ignored`);
    return true;
  }

  return false;
}

/**
 * 处理数据块变化
 */
async function handleBlockChange(data: {
  blocks: BlockEntity[];
  txData: IDatom[];
  txMeta?: {
    outlinerOp: string;
    [key: string]: any;
  };
}) {
  try {
    // 过滤不相关的操作
    if (data.txMeta?.outlinerOp !== "save-block") return;
    if (data.txMeta?.undo || data.txMeta?.redo) return;

    const {
      createTimePropertyName,
      updateTimePropertyName,
      useGitCreationTime,
      ignorePages,
    } = logseq.settings as unknown as Settings;

    // 并行获取块信息和用户配置
    if (!data.blocks?.length) return;
    const blockPromise = logseq.Editor.getBlock(data.blocks[0].uuid);
    const userConfigsPromise = logseq.App.getUserConfigs();

    const block = await blockPromise;
    const pageId = block?.page.id as number;
    if (!pageId) return;

    const currentPage = await logseq.Editor.getPage(pageId, {
      includeChildren: false,
    });

    if (!currentPage || !currentPage.updatedAt) return;

    // 检查页面是否应该被忽略
    if (shouldIgnorePage(currentPage, ignorePages)) return;

    const updatedAt = currentPage.updatedAt as number;
    const fileId = currentPage.file?.id;

    // 并行获取所有需要的数据
    const [userConfigs, resolvedCreatedAt] = await Promise.all([
      userConfigsPromise,
      getPageCreationTime(fileId, useGitCreationTime, new Date().getTime()),
    ]);

    // 将时间戳转换为用户首选的日期格式
    const { preferredDateFormat } = userConfigs;
    const formattedUpdatedAt = format(new Date(updatedAt), preferredDateFormat);
    const formattedCreatedAt = format(
      new Date(resolvedCreatedAt),
      preferredDateFormat
    );

    // 在后台处理日期更新，不阻塞主流程
    handleDate(
      currentPage.uuid,
      formattedUpdatedAt,
      formattedCreatedAt,
      updateTimePropertyName,
      createTimePropertyName
    ).catch((error) => console.error("Error updating date properties:", error));
  } catch (error) {
    console.error("Error in handleBlockChange:", error);
  }
}

/**
 * 注册数据块变化监听器
 */
function registerBlockChangeListener() {
  logseq.DB.onChanged(async (data) => {
    await handleBlockChange(data).catch((error) => {
      console.error("Error handling block change:", error);
    });
  });
}

/**
 * 处理日期更新
 */
async function handleDate(
  pageIdentity: PageIdentity,
  updatedAt: string,
  createdAt: string,
  updateTimePropertyName: string,
  createTimePropertyName: string
) {
  const currentBlocksTree = await logseq.Editor.getPageBlocksTree(pageIdentity);

  if (!currentBlocksTree || currentBlocksTree.length === 0) return;

  const firstBlock = await logseq.Editor.getBlock(currentBlocksTree[0].uuid);

  if (!firstBlock) return;

  // 如果已经有 created 属性，并且 updated 属性也是当天的话就直接退出
  if (
    firstBlock.content?.includes(`${createTimePropertyName}:: `) &&
    firstBlock.content?.includes(`${updateTimePropertyName}:: `)
  ) {
    const created = firstBlock.content?.match(
      new RegExp(
        `${createTimePropertyName}:: \\[\\[([^\\]]+)\\]\\](?:\\r?\\n|$)`
      )
    );
    const updated = firstBlock.content?.match(
      new RegExp(
        `${updateTimePropertyName}:: \\[\\[${updatedAt}\\]\\](?:\\r?\\n|$)`
      )
    );

    if (created && updated) return;
  }

  // 处理已有 updated 属性或者 created 属性的情况
  if (
    firstBlock.content?.includes(`${updateTimePropertyName}:: `) ||
    firstBlock.content?.includes(`${createTimePropertyName}:: `)
  ) {
    await updateExistingProperties(
      firstBlock,
      currentBlocksTree[0].uuid,
      updatedAt,
      createdAt,
      updateTimePropertyName,
      createTimePropertyName
    );
  } else {
    await addNewProperties(
      firstBlock,
      currentBlocksTree[0].uuid,
      updatedAt,
      createdAt,
      updateTimePropertyName,
      createTimePropertyName
    );
  }
}

/**
 * 更新已存在的属性
 */
async function updateExistingProperties(
  firstBlock: BlockEntity,
  blockUuid: string,
  updatedAt: string,
  createdAt: string,
  updateTimePropertyName: string,
  createTimePropertyName: string
) {
  const oldContent = firstBlock.content;
  let newContent = oldContent;

  // 更新 updated 属性
  if (oldContent.includes(`${updateTimePropertyName}:: `)) {
    newContent = newContent.replace(
      new RegExp(
        `${updateTimePropertyName}:: \\[\\[[^\\]]+\\]\\](?:\\r?\\n|$)`
      ),
      `${updateTimePropertyName}:: [[${updatedAt}]]\n`
    );
  } else {
    // 如果没有 updated 属性，添加它
    newContent = `${newContent}\n${updateTimePropertyName}:: [[${updatedAt}]]\n`;
  }

  // 如果没有 created 属性，添加它;如果有的话不动，因为创建时间不会变
  if (!oldContent.includes(`${createTimePropertyName}:: `)) {
    newContent = `${newContent}\n${createTimePropertyName}:: [[${createdAt}]]\n`;
  }

  await logseq.Editor.updateBlock(blockUuid, newContent);
}

/**
 * 添加新的属性
 */
async function addNewProperties(
  firstBlock: BlockEntity,
  blockUuid: string,
  updatedAt: string,
  createdAt: string,
  updateTimePropertyName: string,
  createTimePropertyName: string
) {
  // 检查第一个块是否为属性块（每行都是 xxx:: xxx 的形式）
  const oldContent = firstBlock?.content;
  const isPropertyBlock = oldContent
    ?.split("\n")
    .every((line) => line.trim() === "" || /^[^:]+::/.test(line.trim()));

  // 如果是属性块，直接在末尾添加新的属性
  if (isPropertyBlock) {
    const newContent = `${oldContent}\n${createTimePropertyName}:: [[${createdAt}]]\n${updateTimePropertyName}:: [[${updatedAt}]]\n`;
    await logseq.Editor.updateBlock(blockUuid, newContent);
  } else {
    // 如果不是属性块，创建新的属性块
    await logseq.Editor.insertBlock(
      firstBlock.uuid,
      `${createTimePropertyName}:: [[${createdAt}]]\n${updateTimePropertyName}:: [[${updatedAt}]]\n`,
      { before: true }
    );
  }
}

/**
 * 主函数
 */
async function main() {
  console.info(`#${pluginId}: MAIN`);

  // 初始化插件设置
  initializeSettings();

  // 加载设置模式
  await loadSettingsSchema();

  // 注册块变化监听器
  registerBlockChangeListener();
}

// 启动插件
logseq.ready(main).catch(console.error);
