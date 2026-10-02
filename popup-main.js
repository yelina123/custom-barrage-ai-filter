// 浏览器右上角插件图标的 popup 配置页入口。
// 复用页面内的 SettingsPanel 组件，配置通过 chrome.storage.local 与内容脚本共享。

import { createApp } from "vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import { store } from "./src/services/state";

async function bootstrap() {
  await store.loadApiConfig();
  await store.loadBlockedHistory();
  createApp(SettingsPanel).mount("#app");
}

void bootstrap();
