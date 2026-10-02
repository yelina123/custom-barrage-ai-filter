<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import {
  store, type SpoilState, type BlockedRecord,
  normalizeBlockedHistoryMaxKB, MIN_BLOCKED_HISTORY_MAX_KB, MAX_BLOCKED_HISTORY_MAX_KB,
} from "../src/services/state";
import { testApi, type ApiTestResult } from "../src/services/classify";
import {
  MAX_BATCH_SIZE, MAX_CONCURRENCY, optionalRequestTimeout,
  normalizeBaseUrl, normalizeConnection,
  normalizeBatchSize, normalizeConcurrency,
} from "../src/services/api-config";

import {
  DEFAULT_SYSTEM_PROMPT, DEFAULT_QUESTION, DEFAULT_RULES, MAX_RULES,
  normalizeSystemPrompt, normalizeQuestion, normalizeRules,
} from "../src/services/prompts";
import { clearVideoCache, hasVideoCache } from "../src/extension/video-cache";

const state = ref<SpoilState>({ ...store.get() });
let unsub: (() => void) | null = null;

// API 板块
const keyInput = ref(state.value.apiKey);
const baseUrlInput = ref(state.value.baseUrl);
const apiModeInput = ref<"jev" | "openai">(state.value.apiMode);
const connectionInput = ref(normalizeConnection(state.value));
const systemPromptInput = ref(state.value.systemPrompt);
const filterQuestionInput = ref(state.value.filterQuestion);
const requestTimeoutSecondsInput = ref(state.value.requestTimeoutSeconds);
// 功能板块
const batchSizeInput = ref(state.value.batchSize);
const concurrencyInput = ref(state.value.concurrency);
const replaceTextInput = ref(state.value.replaceText);
const blockedHistoryLimitInput = ref(state.value.blockedHistoryMaxKB);
// 规则编辑器
const promptModeInput = ref<"rules" | "manual">(state.value.promptMode);
const ruleInputs = ref<string[]>([...state.value.filterRules]);

const hasCache = ref(false);
let cacheTimer: ReturnType<typeof setInterval> | null = null;
let checkingCache = false;
let disposed = false;
let cacheRevision = 0;
async function refreshCacheStatus() {
  if (checkingCache || clearState.value === "clearing") return;
  checkingCache = true;
  const revision = cacheRevision;
  try {
    const available = await hasVideoCache();
    if (!disposed && revision === cacheRevision) hasCache.value = available;
  } catch { if (!disposed && revision === cacheRevision) hasCache.value = false; }
  finally { checkingCache = false; }
}

onMounted(() => {
  void refreshCacheStatus();
  cacheTimer = setInterval(() => { void refreshCacheStatus(); }, 2000);
  unsub = store.subscribe((s) => {
    // 日志、阈值或进度更新不覆盖尚未提交的编辑。
    if (s.systemPrompt !== state.value.systemPrompt) systemPromptInput.value = s.systemPrompt;
    if (s.filterQuestion !== state.value.filterQuestion) filterQuestionInput.value = s.filterQuestion;
    if (s.promptMode !== state.value.promptMode) promptModeInput.value = s.promptMode;
    if (JSON.stringify(s.filterRules) !== JSON.stringify(state.value.filterRules)) {
      ruleInputs.value = [...s.filterRules];
    }
    if (s.baseUrl !== state.value.baseUrl) baseUrlInput.value = s.baseUrl;
    if (s.apiMode !== state.value.apiMode) apiModeInput.value = s.apiMode;
    for (const key of ['model'] as const) {
      if (s[key] !== state.value[key]) connectionInput.value[key] = s[key];
    }
    state.value = { ...s };
    keyInput.value = s.apiKey;
    requestTimeoutSecondsInput.value = s.requestTimeoutSeconds;
    batchSizeInput.value = s.batchSize;
    concurrencyInput.value = s.concurrency;
    replaceTextInput.value = s.replaceText;
    blockedHistoryLimitInput.value = s.blockedHistoryMaxKB;
  });
});
onBeforeUnmount(() => {
  disposed = true;
  if (cacheTimer) clearInterval(cacheTimer);
  if (clearTimer) clearTimeout(clearTimer);
  if (unsub) unsub();
});

/** 把当前所有设置写回 store 并持久化(及时生效,无保存按钮) */
function persist() {
  const mode = promptModeInput.value === "manual" ? "manual" as const : "rules" as const;
  const rules = normalizeRules(ruleInputs.value);
  const cfg = {
    ...normalizeConnection(connectionInput.value),
    apiKey: keyInput.value.trim(),
    baseUrl: normalizeBaseUrl(baseUrlInput.value),
    apiMode: apiModeInput.value,
    promptMode: mode,
    filterRules: rules,
    // 规则模式下提示词由规则生成（setFilterRules 已同步到 store）；手动模式取输入框。
    systemPrompt: mode === "rules" ? store.get().systemPrompt : normalizeSystemPrompt(systemPromptInput.value),
    filterQuestion: mode === "rules" ? store.get().filterQuestion : normalizeQuestion(filterQuestionInput.value),
    requestTimeoutSeconds: optionalRequestTimeout(requestTimeoutSecondsInput.value),
    hideThreshold: store.get().hideThreshold,
    batchSize: normalizeBatchSize(batchSizeInput.value),
    concurrency: normalizeConcurrency(concurrencyInput.value),
    // 留空（含空格）时归一为单个空格：弹幕等同消失，不显示任何占位文字。
    replaceText: replaceTextInput.value.trim() === "" ? " " : replaceTextInput.value.trim(),
    blockedHistoryMaxKB: normalizeBlockedHistoryMaxKB(blockedHistoryLimitInput.value),
  };
  store.patch(cfg);
  systemPromptInput.value = cfg.systemPrompt;
  filterQuestionInput.value = cfg.filterQuestion;
  baseUrlInput.value = cfg.baseUrl;
  connectionInput.value = normalizeConnection(cfg);
  void store.saveApiConfig(cfg);
}

/** API 板块:任一输入变化即保存(去掉保存按钮,及时生效) */
function onApiChange() {
  persist();
}

/** 功能板块:数字/文本输入变化即保存 */
function onFeatureChange() {
  persist();
}

// ---- 规则列表操作 ----
/** 规则增删改后：同步内存态并完整持久化（空规则行会被自动忽略）。 */
function persistRules() {
  store.setFilterRules(ruleInputs.value);
  persist();
}

function addRule() {
  if (ruleInputs.value.length >= MAX_RULES) return;
  ruleInputs.value = [...ruleInputs.value, ""];
  persistRules();
}

function removeRule(index: number) {
  ruleInputs.value = ruleInputs.value.filter((_, i) => i !== index);
  persistRules();
}

function onRulesChange() {
  persistRules();
}

function resetRules() {
  ruleInputs.value = [...DEFAULT_RULES];
  promptModeInput.value = "rules";
  persistRules();
}

/** 规则模式 ↔ 手动模式互斥切换。 */
function toggleMode() {
  const next = promptModeInput.value === "rules" ? "manual" : "rules";
  promptModeInput.value = next;
  store.setPromptMode(next);
  persist();
}

function resetSystemPrompt() {
  systemPromptInput.value = DEFAULT_SYSTEM_PROMPT;
  persist();
}

function resetQuestion() {
  filterQuestionInput.value = DEFAULT_QUESTION;
  persist();
}

function onHistoryLimitChange() {
  store.setBlockedHistoryMaxKB(blockedHistoryLimitInput.value);
  persist();
}

/** 当前屏蔽历史占用的存储空间（KB，保留 1 位小数）。 */
function historyUsedKB(): string {
  const bytes = state.value.blockedHistory.reduce((sum, item) => {
    const json = JSON.stringify(item);
    return sum + (typeof Blob !== "undefined" ? new Blob([json]).size : json.length);
  }, 0);
  return (bytes / 1024).toFixed(1);
}

function handleClearHistory() {
  store.clearBlockedHistory();
}

function formatBlockedTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type ClearState = "idle" | "clearing" | "ok" | "error";
const clearState = ref<ClearState>("idle");
const clearMsg = ref<string>("");
let clearTimer: ReturnType<typeof setTimeout> | null = null;

async function handleClearCache() {
  if (!hasCache.value || clearState.value === "clearing") return;
  clearState.value = "clearing";
  cacheRevision++;
  clearMsg.value = "";
  try {
    const n = await clearVideoCache();
    hasCache.value = false;
    clearState.value = "ok";
    clearMsg.value = n > 0 ? "已清空视频缓存" : "缓存已是空的";
  } catch (e: any) {
    clearState.value = "error";
    clearMsg.value = "清理失败：" + (e?.message || String(e));
  }
  // 几秒后自动回到初始态，避免状态残留
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearState.value = "idle";
    clearMsg.value = "";
  }, 4000);
}

// ---- 测试 API 连接 ----
type TestState = "idle" | "testing" | "ok" | "error";
const testState = ref<TestState>("idle");
const testCode = ref<string>("");
const testMsg = ref<string>("");

async function handleTestApi() {
  if (testState.value === "testing") return;
  // 先把未提交的规则/提示词编辑落盘，保证测试的是当前界面配置。
  persist();
  testState.value = "testing";
  testCode.value = "";
  testMsg.value = "";
  const cfg = {
    ...normalizeConnection(connectionInput.value),
    apiKey: keyInput.value.trim(),
    baseUrl: normalizeBaseUrl(baseUrlInput.value),
    apiMode: apiModeInput.value,
    systemPrompt: store.get().systemPrompt,
    filterQuestion: store.get().filterQuestion,
    hideThreshold: store.get().hideThreshold,
    requestTimeoutSeconds: optionalRequestTimeout(requestTimeoutSecondsInput.value),
  };
  try {
    const r: ApiTestResult = await testApi(cfg);
    if (r.ok) {
      testState.value = "ok";
      testMsg.value = `连接成功 · ${(r.elapsedMs / 1000).toFixed(2)} 秒`;
    } else {
      testState.value = "error";
      testCode.value = r.code;
      testMsg.value = r.message;
    }
  } catch (e: any) {
    testState.value = "error";
    testCode.value = e?.name || "Error";
    testMsg.value = e?.message || String(e);
  }
}
</script>

<template>
  <div class="setting-shell">
    <!-- API 板块 -->
    <div class="setting-group">
      <div class="setting-group-title-wrap"><span class="setting-group-title">API</span></div>
      <label class="setting-label" for="jev-api-mode">协议模式</label>
      <select id="jev-api-mode" v-model="apiModeInput" class="key-input" @change="onApiChange">
        <option value="jev">Jev Decisions（默认）</option>
        <option value="openai">OpenAI 兼容（OpenRouter / DeepSeek 等）</option>
      </select>
      <label class="setting-label" for="jev-base-url">Base URL</label>
      <input id="jev-base-url" v-model="baseUrlInput" type="url" class="key-input" :placeholder="apiModeInput === 'openai' ? 'https://openrouter.ai/api/v1/chat/completions' : ''" autocomplete="off" autocapitalize="none" spellcheck="false" @change="onApiChange" />
      <label class="setting-label" for="jev-model">Model</label>
      <input id="jev-model" v-model="connectionInput.model" class="key-input" placeholder="" autocomplete="off" spellcheck="false" @change="onApiChange" />
      <label class="setting-label" for="jev-api-key">API Key</label>
      <input id="jev-api-key" v-model="keyInput" type="text" class="key-input api-key-input" placeholder="" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" @change="onApiChange" />
      <div class="setting-row api-timeout-row">
        <label class="setting-label">请求超时时间（秒）</label>
        <input
          v-model.number="requestTimeoutSecondsInput"
          type="number"
          class="small-input"
          min="1"
          max="600"
          step="1"
          @change="onApiChange"
        />
      </div>
      <span class="api-test-row">
        <button class="btn api-test-btn" :disabled="testState === 'testing'" @click="handleTestApi">测试</button>
        <span v-if="testState === 'testing'" class="api-test-status testing">
          <span class="api-test-spinner"></span>
          <span class="api-test-text">测试中…</span>
        </span>
        <span v-else-if="testState === 'ok'" class="api-test-status ok">
          <svg class="api-test-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span class="api-test-text" :title="testMsg">{{ testMsg }}</span>
        </span>
        <span v-else-if="testState === 'error'" class="api-test-status error" :title="testMsg">
          <svg class="api-test-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          <span class="api-test-text">{{ testMsg || testCode }}</span>
        </span>
      </span>
    </div>

    <div class="setting-divider"></div>

    <!-- 功能板块 -->
    <div class="setting-group">
      <div class="setting-group-title-wrap"><span class="setting-group-title">功能</span></div>

      <div class="prompt-heading">
        <label class="setting-label">过滤规则（命中任意一条即屏蔽）</label>
        <button class="prompt-reset" @click="toggleMode">
          {{ promptModeInput === 'rules' ? '手动编辑提示词' : '返回规则编辑' }}
        </button>
      </div>

      <!-- 规则模式：图形化列表 -->
      <template v-if="promptModeInput === 'rules'">
        <div class="rules-list">
          <div v-for="(_, i) in ruleInputs" :key="i" class="rule-row">
            <span class="rule-index">{{ i + 1 }}</span>
            <input
              v-model="ruleInputs[i]"
              type="text"
              class="rule-input"
              placeholder="描述要过滤的内容，如：包含脏话或辱骂"
              autocomplete="off"
              spellcheck="false"
              @change="onRulesChange"
            />
            <button class="rule-del" title="删除该规则" @click="removeRule(i)">×</button>
          </div>
        </div>
        <div class="rule-footer">
          <button class="rule-add" :disabled="ruleInputs.length >= MAX_RULES" @click="addRule">+ 添加规则</button>
          <span class="rule-count">{{ ruleInputs.length }}/{{ MAX_RULES }}</span>
          <button class="prompt-reset" @click="resetRules">恢复默认规则</button>
        </div>
      </template>

      <!-- 手动模式：直接编辑提示词与问题 -->
      <template v-else>
        <div class="prompt-heading">
          <label class="setting-label" for="jev-system-prompt">系统提示词（定义过滤规则）</label>
          <button class="prompt-reset" @click="resetSystemPrompt">恢复默认</button>
        </div>
        <textarea id="jev-system-prompt" v-model="systemPromptInput" class="key-input system-prompt-input" rows="5" spellcheck="false" @change="persist"></textarea>

        <div class="prompt-heading">
          <label class="setting-label" for="jev-filter-question">判断问题（逐条询问 AI）</label>
          <button class="prompt-reset" @click="resetQuestion">恢复默认</button>
        </div>
        <input id="jev-filter-question" v-model="filterQuestionInput" type="text" class="key-input" autocomplete="off" spellcheck="false" @change="persist" />
      </template>

      <div class="setting-row">
        <label class="setting-label">单次请求处理弹幕数量</label>
        <input v-model.number="batchSizeInput" type="number" class="small-input" min="1" :max="MAX_BATCH_SIZE" step="1" @change="onFeatureChange" />
      </div>
      <div class="setting-row">
        <label class="setting-label">请求并发数</label>
        <input v-model.number="concurrencyInput" type="number" class="small-input" min="1" :max="MAX_CONCURRENCY" step="1" @change="onFeatureChange" />
      </div>
      <div class="setting-row">
        <label class="setting-label">命中弹幕替换文本（留空 = 一个空格）</label>
        <input v-model="replaceTextInput" type="text" class="small-input" placeholder="空格" autocomplete="off" spellcheck="false" @change="onFeatureChange" />
      </div>

      <div class="setting-divider"></div>

      <div class="setting-group-title-wrap"><span class="setting-group-title">屏蔽历史</span></div>
      <div class="setting-row">
        <label class="setting-label">存储空间上限（KB）</label>
        <input
          v-model.number="blockedHistoryLimitInput"
          type="number"
          class="small-input"
          :min="MIN_BLOCKED_HISTORY_MAX_KB"
          :max="MAX_BLOCKED_HISTORY_MAX_KB"
          step="10"
          @change="onHistoryLimitChange"
        />
      </div>
      <div class="history-head">
        <span class="setting-label">已屏蔽 {{ state.blockedHistory.length }} 条 · 占用 {{ historyUsedKB() }} KB</span>
        <button class="prompt-reset" :disabled="!state.blockedHistory.length" @click="handleClearHistory">清空历史</button>
      </div>
      <div class="history-list" v-if="state.blockedHistory.length">
        <div v-for="(item, i) in state.blockedHistory" :key="i" class="history-item">
          <div class="history-text">{{ item.text }}</div>
          <div class="history-meta">
            <span class="history-time">{{ formatBlockedTime(item.blockedAt) }}</span>
            <a class="history-video" :href="item.videoUrl" target="_blank" rel="noopener noreferrer">{{ item.videoTitle || '未知视频' }}</a>
          </div>
        </div>
      </div>
      <div v-else class="history-empty">暂无屏蔽记录</div>

      <span class="clear-cache-row">
        <button class="btn danger" :disabled="!hasCache || clearState === 'clearing'" @click="handleClearCache">清除上次分析缓存</button>
        <span v-if="clearState === 'clearing'" class="clear-cache-status clearing">
          <span class="clear-cache-spinner"></span>
          <span class="clear-cache-text">正在清理…</span>
        </span>
        <span v-else-if="clearState === 'ok'" class="clear-cache-status ok" :title="clearMsg">
          <svg class="clear-cache-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span class="clear-cache-text">{{ clearMsg }}</span>
        </span>
        <span v-else-if="clearState === 'error'" class="clear-cache-status error" :title="clearMsg">
          <svg class="clear-cache-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          <span class="clear-cache-text">{{ clearMsg }}</span>
        </span>
      </span>
    </div>

    <div class="setting-footer">
      <a
        class="github-link"
        href="https://github.com/yelina123/custom-barrage-ai-filter"
        target="_blank"
        rel="noopener noreferrer"
        title="访问项目 GitHub 仓库"
        aria-label="访问项目 GitHub 仓库"
      >
        <svg class="github-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.68 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.14c.98 0 1.96.13 2.88.39 2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.08 0 4.41-2.71 5.38-5.29 5.67.42.36.79 1.07.79 2.16v3.24c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/>
        </svg>
        <span>GitHub</span>
      </a>
    </div>
  </div>
</template>

<style scoped>
.prompt-heading { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.prompt-reset { border: 0; background: none; padding: 0; font: inherit; font-size: 11px; color: #8a919f; cursor: pointer; }
.prompt-reset:hover { color: #1f2329; }
.system-prompt-input { resize: vertical; min-height: 100px; line-height: 1.6; margin-bottom: 4px; }

/* 规则列表 */
.rules-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.rule-row { display: flex; align-items: center; gap: 6px; }
.rule-index { width: 20px; flex-shrink: 0; text-align: right; font-size: 11px; color: #8a919f; }
.rule-input {
  flex: 1; min-width: 0; box-sizing: border-box;
  padding: 6px 8px; border: 1px solid #e4e7ec; background: #fff;
  border-radius: 6px; font-size: 12px; color: #1f2329;
}
.rule-input:focus { outline: none; border-color: #1a1a1a; }
.rule-del {
  width: 24px; height: 24px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  border: 0; background: none; color: #8a919f; cursor: pointer;
  border-radius: 6px; font-size: 15px; line-height: 1; padding: 0;
}
.rule-del:hover { color: #d64545; background: #fdeaea; }
.rule-footer { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.rule-add {
  border: 1px dashed #c9ced6; background: #f7f8fa; color: #4e5969;
  border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer;
}
.rule-add:hover:not(:disabled) { border-color: #1a1a1a; color: #1a1a1a; }
.rule-add:disabled { opacity: 0.6; cursor: default; }
.rule-count { font-size: 11px; color: #8a919f; }

.setting-shell {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #1f2329;
}
.setting-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: auto;
  padding-top: 14px;
  flex-shrink: 0;
}
.github-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #8a919f;
  font-size: 12px;
  line-height: 1;
  text-decoration: none;
  transition: color 0.15s ease;
}
.github-link:hover { color: #1f2329; }
.github-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.setting-group-title-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.setting-group-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2329;
}
.setting-label { font-size: 12px; color: #8a919f; }
.key-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 7px;
  border: 1px solid #e4e7ec;
  background: #ffffff;
  color: #1f2329;
  border-radius: 8px;
  font-size: 13px;
  min-width: 0;
  margin-bottom: 12px;
}
.key-input:focus { outline: none; border-color: #1a1a1a; }
.api-key-input { -webkit-text-security: disc; }
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.setting-row.api-timeout-row { margin-bottom: 12px; }
.setting-row .setting-label { flex: 1; min-width: 0; }
.small-input {
  width: 70px;
  box-sizing: border-box;
  padding: 5px 6px;
  border: 1px solid #e4e7ec;
  background: #ffffff;
  color: #1f2329;
  border-radius: 6px;
  font-size: 12px;
  text-align: center;
  flex-shrink: 0;
}
.small-input:focus { outline: none; border-color: #1a1a1a; }
.btn {
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: #1a1a1a;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.btn:hover { background: #000; }
.setting-divider { height: 1px; background: #ebeef3; margin: 12px 0; }
.btn.danger { background: #fdeaea; color: #d64545; margin-top: 6px; }
.btn.danger:hover { background: #fbdcdc; }
.btn.danger:disabled { opacity: 0.6; cursor: default; }
.clear-cache-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.clear-cache-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}
.clear-cache-status.clearing { color: #8a919f; }
.clear-cache-status.ok { color: #2e9e5b; }
.clear-cache-status.error { color: #d64545; }
.clear-cache-mark { flex-shrink: 0; }
.clear-cache-text { white-space: nowrap; }
.clear-cache-spinner {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid #c9ced6;
  border-top-color: #8a919f;
  border-radius: 50%;
  animation: clear-cache-spin 0.8s linear infinite;
}
@keyframes clear-cache-spin { to { transform: rotate(360deg); } }
.api-test-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.api-test-btn {
  padding: 5px 12px;
  font-size: 12px;
  background: #1a1a1a;
  color: #fff;
}
.api-test-btn:hover { background: #000; }
.api-test-btn:disabled { opacity: 0.6; cursor: default; }
.api-test-status {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
}
.api-test-status.testing { color: #8a919f; }
.api-test-status.ok { color: #2e9e5b; }
.api-test-status.error { color: #d64545; }
.api-test-mark { flex-shrink: 0; }
.api-test-text { overflow-wrap: anywhere; }
.api-test-spinner {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid #c9ced6;
  border-top-color: #8a919f;
  border-radius: 50%;
  animation: api-test-spin 0.8s linear infinite;
}
@keyframes api-test-spin { to { transform: rotate(360deg); } }

/* 屏蔽历史 */
.history-head { display: flex; align-items: center; justify-content: space-between; margin: 4px 0 8px; }
.history-list {
  overflow-y: auto;
  border: 1px solid #ebeef3; border-radius: 8px;
  padding: 4px 8px; margin-bottom: 8px;
}
.history-item { padding: 6px 0; border-bottom: 1px solid #f2f3f5; }
.history-item:last-child { border-bottom: none; }
.history-text { font-size: 12px; color: #1f2329; line-height: 1.4; word-break: break-all; }
.history-meta { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
.history-time { font-size: 11px; color: #8a919f; flex-shrink: 0; }
.history-video {
  font-size: 11px; color: #00a1d6; text-decoration: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.history-video:hover { text-decoration: underline; }
.history-empty { font-size: 12px; color: #8a919f; text-align: center; padding: 14px 0; }
</style>
