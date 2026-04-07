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


const pluginId = pluginInfo.id;

interface Settings {
  createTimePropertyName: string;
  updateTimePropertyName: string;
  useGitCreationTime: boolean;
  ignorePages: string;
  forceUpdateCreatedTime: boolean;
  checkOnPageLoad: boolean;
}

// 获取 git 文件创建时间，支持 .md -> .org 重命名场景
async function getGitFileCreationTime(fileId: number) {
  // 使用 :find ?file . 语法直接返回单一值
  const filePathResult = await logseq.DB.datascriptQuery(
    `[:find ?file . :where [?b :file/path ?file] [(== ?b ${fileId})]]`
  );
  if (!filePathResult) throw new Error("file not found");

  const filePath = filePathResult;
  const logseqGraphFolder = (await logseq.App.getCurrentGraph())?.path;
  if (!logseqGraphFolder) throw new Error("logseq graph folder not found");

  console.log(`[git-creation-time] 开始获取文件创建时间: ${filePath}`);

  // 并行收集所有可能的创建时间，最终取最早（最小）的那个。
  // 这样即使 --follow 在 .md 上成功返回了（但只是 .md 的创建时间），
  // .org 的更早时间也不会被忽略。
  const timePromises: Promise<number | null>[] = [];

  // 策略1: 使用 --follow 追踪当前文件的完整重命名历史
  timePromises.push(
    tryGetGitCreationTimeWithFollow(logseqGraphFolder, filePath)
      .then(t => { if (t) console.log(`[git-creation-time] --follow 结果: ${new Date(t).toISOString()}`); return t; })
  );

  // 策略2: 如果当前文件是 .md，直接查找同路径下的 .org 文件的 git 历史
  // （处理文件从 .org 转为 .md 但 git 未能识别为重命名的场景）
  if (/\.md$/i.test(filePath)) {
    const orgFilePath = filePath.replace(/\.md$/i, ".org");
    console.log(`[git-creation-time] 同时查找 .org 文件历史: ${orgFilePath}`);
    timePromises.push(
      tryGetGitCreationTimeWithFollow(logseqGraphFolder, orgFilePath)
        .then(t => { if (t) console.log(`[git-creation-time] .org 文件结果: ${new Date(t).toISOString()}`); return t; })
    );
  }

  // 并行执行所有策略
  const times = await Promise.all(timePromises);
  const validTimes = times.filter((t): t is number => t !== null);

  if (validTimes.length > 0) {
    const earliest = Math.min(...validTimes);
    console.log(`[git-creation-time] 最终选择最早时间: ${new Date(earliest).toISOString()} (从 ${validTimes.length} 个结果中)`);
    return earliest;
  }

  // 策略4: 尝试通过 git log --follow 查找原始文件名，再尝试 .org 版本
  const originalName = await tryGetOriginalFileName(logseqGraphFolder, filePath);
  if (originalName && originalName !== filePath) {
    console.log(`[git-creation-time] 发现原始文件名: ${originalName}`);
    if (/\.md$/i.test(originalName)) {
      const orgOriginalPath = originalName.replace(/\.md$/i, ".org");
      console.log(`[git-creation-time] 尝试原始文件的 .org 版本: ${orgOriginalPath}`);
      const orgOriginalTime = await tryGetGitCreationTimeWithFollow(logseqGraphFolder, orgOriginalPath);
      if (orgOriginalTime) {
        console.log(`[git-creation-time] 通过原始 .org 文件获取到创建时间: ${new Date(orgOriginalTime).toISOString()}`);
        return orgOriginalTime;
      }
    }
  }

  throw new Error("cannot get git creation time");
}

// 使用 --follow --reverse 追踪文件完整历史，取最早的提交时间
async function tryGetGitCreationTimeWithFollow(
  logseqGraphFolder: string,
  filePath: string
): Promise<number | null> {
  try {
    const gitCommand = [
      "-C",
      logseqGraphFolder,
      "log",
      "--format=%at",
      "--follow",
      "--reverse",
      "--",
      filePath,
    ];

    const result = await (logseq.Git?.execCommand?.(gitCommand) ??
      Promise.reject(new Error("Git helper unavailable")));
    if (!result.stdout) return null;

    // --reverse 后第一行就是最早的提交时间
    const firstLine = result.stdout.trim().split("\n")[0];
    if (!/^\d+$/.test(firstLine)) return null;

    return Number(firstLine) * 1000;
  } catch {
    return null;
  }
}

// 尝试获取文件重命名前的原始文件名
async function tryGetOriginalFileName(
  logseqGraphFolder: string,
  filePath: string
): Promise<string | null> {
  try {
    // 使用 --follow --name-only --diff-filter=A 查找文件最初被添加时的名字
    const gitCommand = [
      "-C",
      logseqGraphFolder,
      "log",
      "--follow",
      "--name-only",
      "--format=",
      "--reverse",
      "--",
      filePath,
    ];

    const result = await (logseq.Git?.execCommand?.(gitCommand) ??
      Promise.reject(new Error("Git helper unavailable")));
    if (!result.stdout) return null;

    // --reverse 后第一个非空行就是最早的文件名
    const lines = result.stdout.trim().split("\n").filter((l: string) => l.trim());
    return lines.length > 0 ? lines[0].trim() : null;
  } catch {
    return null;
  }
}

// 正在进行中的 git 查询 map，用于去重并发请求
// 当同一个 fileId 的 git 查询正在运行时，后续请求直接等待相同的 Promise
const inflightFetches = new Map<number, Promise<number>>();

// git 创建时间缓存（首次 commit 时间不会变，用普通 Map 即可）
// Map<fileId, creationTimeMs>
const gitCreationTimeCache = new Map<number, number>();

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
      forceUpdateCreatedTime: false,
      checkOnPageLoad: false,
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
    // 先检查 LRU cache（已有结果）
    const cached = gitCreationTimeCache.get(fileId);
    if (cached !== undefined) return cached;

    // 如果已经有正在进行的 git 查询，直接等待同一个 Promise（避免 race condition）
    const inflight = inflightFetches.get(fileId);
    if (inflight) {
      console.log(`[git-creation-time] fileId=${fileId} 查询进行中，等待已有的 Promise`);
      return inflight.catch(() => fallbackTime);
    }

    // 发起新的查询，并登记到 inflight map
    const fetchPromise = getGitFileCreationTime(fileId)
      .then((result) => {
        gitCreationTimeCache.set(fileId, result);
        return result;
      })
      .finally(() => {
        inflightFetches.delete(fileId);
      });

    inflightFetches.set(fileId, fetchPromise);
    return fetchPromise.catch(() => fallbackTime);
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

    console.log("handleBlockChange", JSON.stringify(data));

    // 并行获取块信息
    if (!data.blocks?.length) return;
    const block = await logseq.Editor.getBlock(data.blocks[0].uuid);
    const pageId = block?.page.id as number;
    if (!pageId) return;

    const currentPage = await logseq.Editor.getPage(pageId, {
      includeChildren: false,
    });

    console.log("currentPage", JSON.stringify(currentPage));

    if (!currentPage || !currentPage.updatedAt) return;

    await checkAndUpdatePage(currentPage);
  } catch (error) {
    console.error("Error in handleBlockChange:", error);
  }
}

/**
 * 检查并更新页面日期属性
 */
async function checkAndUpdatePage(currentPage: PageEntity) {
  try {
    const {
      createTimePropertyName,
      updateTimePropertyName,
      useGitCreationTime,
      ignorePages,
      forceUpdateCreatedTime,
    } = logseq.settings as unknown as Settings;

    // 检查页面是否应该被忽略
    if (shouldIgnorePage(currentPage, ignorePages)) return;
    
    const updatedAt = currentPage.updatedAt as number;
    const fileId = currentPage.file?.id;

    // 获取配置和时间
    const [userConfigs, resolvedCreatedAt] = await Promise.all([
      logseq.App.getUserConfigs(),
      getPageCreationTime(fileId, useGitCreationTime, new Date().getTime()),
    ]);

    // 将时间戳转换为用户首选的日期格式
    const { preferredDateFormat } = userConfigs;
    const formattedUpdatedAt = format(new Date(updatedAt), preferredDateFormat);
    const formattedCreatedAt = format(
      new Date(resolvedCreatedAt),
      preferredDateFormat
    );

    console.log("准备调用 handleDate", {
      pageUuid: currentPage.uuid,
      formattedUpdatedAt,
      formattedCreatedAt,
      updateTimePropertyName,
      createTimePropertyName
    });
    // 等待 handleDate 完成（如果你希望它在后台运行也可以去除 await）
    await handleDate(
      currentPage.uuid,
      formattedUpdatedAt,
      formattedCreatedAt,
      updateTimePropertyName,
      createTimePropertyName,
      forceUpdateCreatedTime
    );
  } catch (error) {
    console.error("Error in checkAndUpdatePage:", error);
  }
}

/**
 * 注册路由切换监听器
 */
function registerRouteChangeListener() {
  logseq.App.onRouteChanged(async ({ path, template }) => {
    try {
      const { checkOnPageLoad } = logseq.settings as unknown as Settings;
      if (!checkOnPageLoad) return;

      // 只有在浏览页面时才触发（排除图谱、设置页面等）
      if (template === "/page/:name") {
        const pageName = path.replace(/^\/page\//, '');
        if (!pageName) return;

        const currentPage = await logseq.Editor.getPage(pageName, {
          includeChildren: false,
        });

        if (currentPage && currentPage.updatedAt) {
          console.log(`[route-change] 进入页面 ${pageName}，触发日期检查...`);
          await checkAndUpdatePage(currentPage);
        }
      }
    } catch (error) {
      console.error("Error handling route change:", error);
    }
  });
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
  createTimePropertyName: string,
  forceUpdateCreatedTime: boolean
) {
  console.log("handleDate 开始执行", { pageIdentity, updatedAt, createdAt, updateTimePropertyName, createTimePropertyName, forceUpdateCreatedTime });
  const currentBlocksTree = await logseq.Editor.getPageBlocksTree(pageIdentity);

  if (!currentBlocksTree || currentBlocksTree.length === 0) {
    console.log("handleDate 提前退出: 页面块树为空");
    return;
  }

  const firstBlock = await logseq.Editor.getBlock(currentBlocksTree[0].uuid);
  console.log("获取到第一个块:", { blockUuid: currentBlocksTree[0].uuid, content: firstBlock?.content });

  if (!firstBlock) {
    console.log("handleDate 提前退出: 无法获取第一个块");
    return;
  }

  // 如果已经有 created 属性，并且 updated 属性也是当天的话就直接退出（或者只退出 updated 并考虑 forceUpdate）
  if (
    firstBlock.content?.includes(`${createTimePropertyName}:: `) &&
    firstBlock.content?.includes(`${updateTimePropertyName}:: `)
  ) {
    const created = firstBlock.content?.match(
      new RegExp(
        `${createTimePropertyName}:: \\[\\[([^\\]]+)\\]\\](?:\\r?\\n|$)`
      )
    );
    const updatedCorrect = firstBlock.content?.match(
      new RegExp(
        `${updateTimePropertyName}:: \\[\\[${updatedAt}\\]\\](?:\\r?\\n|$)`
      )
    );
    
    let createdIsCorrect = true;
    if (forceUpdateCreatedTime && created) {
      createdIsCorrect = created[1] === createdAt;
    }

    console.log("正则匹配结果:", { 
      hasCreated: !!created,
      updatedCorrect: !!updatedCorrect,
      expectedUpdatedAt: updatedAt,
      createdIsCorrect,
    });

    if (created && updatedCorrect && createdIsCorrect) {
      console.log("handleDate 提前退出: 满足退出条件（已存在 created、updated 正确，且创建时间正确或未开启强制更新）");
      return;
    }
  }

  // 处理已有 updated 属性或者 created 属性的情况
  if (
    firstBlock.content?.includes(`${updateTimePropertyName}:: `) ||
    firstBlock.content?.includes(`${createTimePropertyName}:: `)
  ) {
    console.log("调用 updateExistingProperties 更新已有属性");
    await updateExistingProperties(
      firstBlock,
      currentBlocksTree[0].uuid,
      updatedAt,
      createdAt,
      updateTimePropertyName,
      createTimePropertyName,
      forceUpdateCreatedTime
    );
  } else {
    console.log("调用 addNewProperties 添加新属性");
    await addNewProperties(
      firstBlock,
      currentBlocksTree[0].uuid,
      updatedAt,
      createdAt,
      updateTimePropertyName,
      createTimePropertyName
    );
  }
  console.log("handleDate 执行完成");
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
  createTimePropertyName: string,
  forceUpdateCreatedTime: boolean
) {
  console.log("updateExistingProperties 开始执行", { blockUuid, updatedAt, createdAt });
  const oldContent = firstBlock.content;
  let newContent = oldContent.trim();

  // 更新 updated 属性
  if (oldContent.includes(`${updateTimePropertyName}:: `)) {
    console.log("更新已有的 updated 属性");
    const oldRegex = new RegExp(
      `${updateTimePropertyName}:: \\[\\[[^\\]]+\\]\\](?:\\r?\\n|$)`
    );
    const oldMatch = oldContent.match(oldRegex);
    console.log("旧的 updated 属性:", oldMatch ? oldMatch[0] : "未找到匹配");
    
    newContent = newContent.replace(
      oldRegex,
      `${updateTimePropertyName}:: [[${updatedAt}]]\n`
    );
  } else {
    // 如果没有 updated 属性，添加它
    console.log("添加新的 updated 属性");
    newContent = `${newContent}\n${updateTimePropertyName}:: [[${updatedAt}]]\n`;
  }

  // 如果没有 created 属性，添加它;如果已存在，根据 forceUpdateCreatedTime 判断是否覆盖
  if (!oldContent.includes(`${createTimePropertyName}:: `)) {
    console.log("添加新的 created 属性");
    newContent = `${newContent}\n${createTimePropertyName}:: [[${createdAt}]]\n`;
  } else {
    if (forceUpdateCreatedTime) {
      const createdRegex = new RegExp(
        `${createTimePropertyName}:: \\[\\[[^\\]]+\\]\\](?:\\r?\\n|$)`
      );
      const oldCreatedMatch = oldContent.match(createdRegex);
      console.log("强制更新已接存在的 created 属性:", oldCreatedMatch ? oldCreatedMatch[0].trim() : "未找到匹配", "->", `${createTimePropertyName}:: [[${createdAt}]]`);
      newContent = newContent.replace(
        createdRegex,
        `${createTimePropertyName}:: [[${createdAt}]]\n`
      );
    } else {
      console.log("保留已有的 created 属性");
    }
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
  console.log("addNewProperties 开始执行", { blockUuid, updatedAt, createdAt });
  // 检查第一个块是否为属性块（每行都是 xxx:: xxx 的形式）
  const oldContent = firstBlock?.content;
  const isPropertyBlock = oldContent
    ?.split("\n")
    .every((line) => line.trim() === "" || /^[^:]+::/.test(line.trim()));
  
  console.log("属性块检查:", { isPropertyBlock, oldContent });

  // 如果是属性块，直接在末尾添加新的属性
  if (isPropertyBlock) {
    console.log("向属性块添加新属性");
    const newContent = `${oldContent}\n${createTimePropertyName}:: [[${createdAt}]]\n${updateTimePropertyName}:: [[${updatedAt}]]\n`;
    console.log("准备更新块", { blockUuid, oldContent, newContent });
    try {
      await logseq.Editor.updateBlock(blockUuid, newContent);
      console.log("块更新成功");
    } catch (error) {
      console.error("块更新失败:", error);
    }
  } else {
    // 如果不是属性块，创建新的属性块
    console.log("创建新的属性块");
    const newContent = `${createTimePropertyName}:: [[${createdAt}]]\n${updateTimePropertyName}:: [[${updatedAt}]]\n`;
    console.log("准备插入块", { parentUuid: firstBlock.uuid, newContent, before: true });
    try {
      await logseq.Editor.insertBlock(
        firstBlock.uuid,
        newContent,
        { before: true }
      );
      console.log("块插入成功");
    } catch (error) {
      console.error("块插入失败:", error);
    }
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

  // 注册路由切换监听器
  registerRouteChangeListener();
}

// 启动插件
logseq.ready(main).catch(console.error);
