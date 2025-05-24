import "@logseq/libs";

import { format } from "date-fns";

import "./index.css";
import { settingSchema } from "./libs/settings";
import { logseq as pluginInfo } from "../package.json";
import { englishSettingSchema } from "./libs/settings_en";
import { PageIdentity } from "@logseq/libs/dist/LSPlugin.user";
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
    filePath
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
  }
});

// main function
async function main() {
  console.info(`#${pluginId}: MAIN`);

  // 初始化设置（当安装插件之后第一次注入）
  if (logseq.settings === undefined) {
    logseq.updateSettings({
      createTimePropertyName: "created",
      updateTimePropertyName: "updated",
    });
  }

  const { preferredLanguage } = await logseq.App.getUserConfigs();
  if (preferredLanguage === "zh-CN") {
    logseq.useSettingsSchema(settingSchema);
  } else {
    logseq.useSettingsSchema(englishSettingSchema);
  }

  // 监听块数据改变
  logseq.DB.onChanged(async (data) => {
    // 只监测数据修改，且不是撤销和重做操作
    if (data.txMeta?.outlinerOp !== "save-block") return;
    if (data.txMeta?.undo || data.txMeta?.redo) return;

    const { createTimePropertyName, updateTimePropertyName , useGitCreationTime, ignorePages} =
      logseq.settings as unknown as Settings;

    const block = await logseq.Editor.getBlock(data.blocks[0].uuid);
    const pageId = block?.page.id as number;

    const currentPage = await logseq.Editor.getPage(pageId, {
      includeChildren: false,
    });

    let createdAt = currentPage?.createdAt as number;
    const updatedAt = currentPage?.updatedAt as number;

    if (!currentPage || !updatedAt) return;

    const fileId = currentPage.file?.id;

    //这里检测 file 是否存在,但是由于我们知道 file 不存在的时候,创建时间一定是今天,所以上面 createdAt 一定是今天,
    if (!fileId) {
      createdAt = Date.now();
    } else if (useGitCreationTime) {
      //通过 fileId 来获取文件信息,进而通过 git 命令来获取文件的创建时间
      const fetchResult = await gitCreationTimeCache.fetch(fileId).catch(() => Date.now());
      createdAt = fetchResult as number;
    }

    // 将时间戳转换为用户首选的日期格式
    const { preferredDateFormat } = await logseq.App.getUserConfigs();
    const formattedUpdatedAt = format(new Date(updatedAt), preferredDateFormat);
    // 确保 createdAt 有值，如果没有则使用当前时间
    const formattedCreatedAt = format(new Date(createdAt), preferredDateFormat);

    // 1. 如果是日记页面，则什么也不添加
    if (currentPage?.["journal?"]) {
      return;
    }

    console.log("currentPage", JSON.stringify(currentPage));
    const ignorePagesList = ignorePages?.split(",")
      .map((page) => page.trim().toLowerCase())
      .filter((page) => page.length > 0) || [];
    if (ignorePagesList?.includes(currentPage.name.toLowerCase())) {
      console.log(`page: ${currentPage.name} defined in ignorePages is ignored`);
      return;
    }

    // 2. 如果是普通页面，则更新页面的 updated 属性和 created 属性
    await handleDate(
      currentPage.uuid,
      formattedUpdatedAt,
      formattedCreatedAt,
      updateTimePropertyName,
      createTimePropertyName
    );
  });

  async function handleDate(
    pageIdentity: PageIdentity,
    updatedAt: string,
    createdAt: string,
    updateTimePropertyName: string,
    createTimePropertyName: string
  ) {
    const currentBlocksTree = await logseq.Editor.getPageBlocksTree(
      pageIdentity
    );

    if (!currentBlocksTree) return;

    if (currentBlocksTree.length > 0) {
      const firstBlock = await logseq.Editor.getBlock(
        currentBlocksTree[0].uuid
      );

      if (!firstBlock) return;

      // 如果已经有 created 属性，并且 updated 属性也是当天的话就直接退出
      if (
        firstBlock.content?.includes(`${createTimePropertyName}:: `) &&
        firstBlock.content?.includes(`${updateTimePropertyName}:: `)
      ) {
        const created = firstBlock.content?.match(
          new RegExp(`${createTimePropertyName}:: (.+)\n`)
        );
        const updated = firstBlock.content?.match(
          new RegExp(`${updateTimePropertyName}:: ${updatedAt}\n`)
        );

        if (created && updated) {
          return;
        }
      }

      // 处理已有updated属性或者created属性的情况
      if (
        (firstBlock &&
          firstBlock.content?.includes(`${updateTimePropertyName}:: `)) ||
        firstBlock.content?.includes(`${createTimePropertyName}:: `)
      ) {
        const oldContent = firstBlock.content;
        let newContent = oldContent;

        // 更新 updated 属性
        if (oldContent.includes(`${updateTimePropertyName}:: `)) {
          newContent = newContent.replace(
            new RegExp(`${updateTimePropertyName}:: (.+)\n`),
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

        await logseq.Editor.updateBlock(currentBlocksTree[0].uuid, newContent);
      } else {
        // 检查第一个块是否为属性块（每行都是 xxx:: xxx 的形式）
        const oldContent = firstBlock?.content;
        const isPropertyBlock = oldContent
          ?.split("\n")
          .every((line) => line.trim() === "" || /^[^:]+::/.test(line.trim()));

        // 如果是属性块，直接在末尾添加新的属性
        if (isPropertyBlock) {
          const newContent = `${oldContent}\n${createTimePropertyName}:: [[${createdAt}]]\n${updateTimePropertyName}:: [[${updatedAt}]]\n`;
          await logseq.Editor.updateBlock(
            currentBlocksTree[0].uuid,
            newContent
          );

          // 如果不是属性块，创建新的属性块
        } else {
          await logseq.Editor.insertBlock(
            firstBlock.uuid,
            `${createTimePropertyName}:: [[${createdAt}]]\n${updateTimePropertyName}:: [[${updatedAt}]]\n`,
            {
              before: true,
              sibling: true,
            }
          );
        }
      }
    }
  }
}

logseq.ready(main).catch(console.error);
