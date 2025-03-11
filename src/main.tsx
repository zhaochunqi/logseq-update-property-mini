import "@logseq/libs";

import { format } from "date-fns";

import "./index.css";
import { getDatePattern } from "./libs/date";
import { settingSchema } from "./libs/settings";
import { logseq as pluginInfo } from "../package.json";
import { BlockEntity, BlockIdentity } from "@logseq/libs/dist/LSPlugin";
import { englishSettingSchema } from "./libs/settings_en";

const pluginId = pluginInfo.id;

interface Settings {
  doneContent: string;
  displayMode: "content" | "property" | "childBlock";
  displayPosition: "left" | "right";
  collapseMode: boolean;
  disabled: boolean;
  isJournalPageAdd: boolean;
}

// main function
async function main() {
  console.info(`#${pluginId}: MAIN`);

  // 初始化设置（当安装插件之后第一次注入）
  if (logseq.settings === undefined) {
    logseq.updateSettings({
      doneContent: "- [[{date}]]",
      displayPosition: "right",
      displayMode: "content",
      collapseMode: true,
      isJournalPageAdd: false,
    });
  }

  const { preferredLanguage } = await logseq.App.getUserConfigs();
  if (preferredLanguage === "zh-CN") {
    logseq.useSettingsSchema(settingSchema);
  } else {
    logseq.useSettingsSchema(englishSettingSchema);
  }

  // 监听新页面创建
  logseq.App.onPageHeadActionsSlotted(async ({ page }) => {
    if (!page) return;
    await updatePageCreatedAt(page.uuid);
  });

  // 监控数据变化
  logseq.DB.onChanged(async (data) => {
    // 只监测数据修改，且不是撤销和重做操作
    if (data.txMeta?.outlinerOp !== "save-block") return;
    if (data.txMeta?.undo || data.txMeta?.redo) return;

    // 更新页面的 updatedAt 属性
    await updatePageUpdatedAt();
  });

  // 辅助函数：更新页面的 updatedAt 属性
  async function updatePageUpdatedAt() {
    const { preferredDateFormat } = await logseq.App.getUserConfigs();
    const currentDate = format(new Date(), preferredDateFormat);
    const currentBlocksTree = await logseq.Editor.getCurrentPageBlocksTree();
    console.log("currentBlocksTree", currentBlocksTree);

    if (!currentBlocksTree) return;

    if (currentBlocksTree.length > 0) {
      const firstBlock = await logseq.Editor.getBlock(
        currentBlocksTree[0].uuid
      );
      console.log("有第一个块");

      if (!firstBlock) return;

      if (firstBlock && firstBlock.content?.includes("updatedat:: ")) {
        // NOTE: update-at因为横线的原因不会显示
        console.log("第一个块包含update-at");
        const oldContent = firstBlock.content;
        const newContent = oldContent.replace(
          /updatedat:: (.+)\n/,
          `updatedat:: ${currentDate}\n`
        );
        await logseq.Editor.updateBlock(currentBlocksTree[0].uuid, newContent);
      } else {
        // 检查是否为属性块（每行都是 xxx:: xxx 的形式）
        const oldContent = firstBlock?.content;
        const isPropertyBlock = oldContent
          ?.split("\n")
          .every((line) => line.trim() === "" || /^[^:]+::/.test(line.trim()));

        // 如果是属性块，直接在末尾添加新的属性
        if (isPropertyBlock) {
          console.log("是属性块");
          const newContent = `${oldContent}\nupdatedat:: ${currentDate}`;
          await logseq.Editor.updateBlock(
            currentBlocksTree[0].uuid,
            newContent
          );

          // 如果不是属性块，仍然是创建第一个块
        } else {
          console.log("不是属性块");
          await logseq.Editor.insertBlock(
            firstBlock.uuid,
            `updatedat:: ${currentDate}`,
            {
              before: true,
              sibling: true,
            }
          );
        }
      }
    }
  }

  // 辅助函数：设置页面的 createdAt 属性（仅当不存在时）
  async function updatePageCreatedAt(pageId: string) {
    const page = await logseq.Editor.getPage(pageId);
    if (!page) return;

    // 获取页面的第一个块
    const blocks = await logseq.Editor.getPageBlocksTree(pageId);
    if (blocks && blocks.length > 0) {
      // 检查是否已存在 created-at 属性
      const block = await logseq.Editor.getBlock(blocks[0].uuid);
      if (block && !block.properties?.["created-at"]) {
        const { preferredDateFormat } = await logseq.App.getUserConfigs();
        const currentDate = format(new Date(), preferredDateFormat);
        await logseq.Editor.upsertBlockProperty(
          blocks[0].uuid,
          "created-at",
          currentDate
        );
      }
    }
  }
}

logseq.ready(main).catch(console.error);
