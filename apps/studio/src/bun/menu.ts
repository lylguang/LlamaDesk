import Electrobun from "electrobun/bun";
import { ApplicationMenu } from "electrobun/bun";
import { APP_NAME } from "./config";
import { updateState, checkForUpdate, applyUpdateNow } from "./updates";

function getUpdateMenuItem() {
  switch (updateState.status) {
    case "checking":
      return { label: "Checking for Updates…", action: "check-for-updates", enabled: false };
    case "downloading":
      return {
        label: `Downloading v${updateState.newVersion}…`,
        action: "check-for-updates",
        enabled: false,
      };
    case "update-ready":
      return { label: "Restart & Update", action: "apply-update" };
    default:
      return { label: "Check for Updates…", action: "check-for-updates" };
  }
}

export const refreshMenu = () => {
  ApplicationMenu.setApplicationMenu([
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        getUpdateMenuItem(),
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ]);
};

export const createMenu = () => {
  refreshMenu();

  Electrobun.events.on("application-menu-clicked", (e) => {
    if (e.data.action === "check-for-updates") {
      checkForUpdate();
    } else if (e.data.action === "apply-update") {
      // 走 applyUpdateNow：先 await 停服再交给 Updater（见 updates.ts 的说明）。
      void applyUpdateNow();
    }
  });
};
