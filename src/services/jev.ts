import { JEV_MODEL, resolveJevApi, buildApiHeaders, normalizeBatchSize, normalizeRequestTimeoutSeconds, normalizeApiMode, type JevConfig } from "./api-config";

import { JEV_QUESTION, normalizeSystemPrompt, normalizeQuestion } from "./prompts";

export type JevDecision = { text: string; probability: number };
export type JevUsage = { inputTokens: number; cost: number | null };
export type JevBatchResult = {
  items: JevDecision[];
  usage: JevUsage;
  elapsedMs: number;
  model: string;
};
export type RetryInfo = { attempt: number; delayMs: number; status: number };

export function buildDecisionRequest(texts: string[], systemPrompt?: string, model = JEV_MODEL, question: string = JEV_QUESTION) {
  return {
    model,
    state: normalizeSystemPrompt(systemPrompt),
    questions: Object.fromEntries(texts.map((text, index) => [
      `dm_${index}`,
      {
        type: "noul" as const,
        instructions: { question: normalizeQuestion(question), danmaku: text },
      },
    ])),
  };
}

// 单条异常长文本仍拒绝发送；批次按用户配置的条数划分，不用 JSON 字节数猜测 Token。
const MAX_QUESTION_BYTES = 24_000;
const encoder = new TextEncoder();

/** OpenAI 兼容模式（OpenRouter / DeepSeek / 本地 Ollama 等）：一批弹幕编号后一次请求，省 token。 */
export function buildOpenAIBatchRequest(
  texts: string[], systemPrompt?: string, model = JEV_MODEL, question: string = JEV_QUESTION,
) {
  const system = `${normalizeSystemPrompt(systemPrompt)}\n${normalizeQuestion(question)}`.trim();
  const lines = texts.map((text, index) => `${index + 1}. ${text}`).join("\n");
  const user = [
    "对每条弹幕判断是否需要屏蔽。对每条输出一行，格式为\"序号: 概率\"（概率为 0 到 1 的小数，越大越应屏蔽），不要输出任何其他内容。",
    lines,
  ].join("\n");
  return {
    model,
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
    temperature: 0,
  };
}

/** 解析 OpenAI 兼容响应：从 choices[0].message.content 逐行提取"序号: 概率"。 */
export function parseOpenAIBatchResponse(
  data: unknown, texts: string[], fallbackModel = JEV_MODEL,
): Omit<JevBatchResult, "elapsedMs"> {
  const response = data as {
    choices?: Array<{ message?: { content?: unknown } }>;
    model?: unknown;
    usage?: { prompt_tokens?: unknown };
  } | null;
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI 兼容接口返回中缺少 choices[0].message.content，无法读取判定。");
  }
  const scores = new Map<number, number>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)[.:、\s]\s*([0-9]*\.?[0-9]+)/);
    if (!match) continue;
    const index = Number(match[1]);
    const score = Number(match[2]);
    if (index >= 1 && index <= texts.length && Number.isFinite(score)) {
      scores.set(index, Math.min(1, Math.max(0, score)));
    }
  }
  const items = texts.map((text, index) => {
    const probability = scores.get(index + 1);
    if (probability === undefined) {
      throw new Error(`OpenAI 兼容接口返回缺少第 ${index + 1} 条判定，请检查模型输出格式。`);
    }
    return { text, probability };
  });
  const promptTokens = response?.usage?.prompt_tokens;
  return {
    items,
    model: typeof response?.model === "string" ? response.model : fallbackModel,
    usage: {
      inputTokens: typeof promptTokens === "number" && Number.isFinite(promptTokens) && promptTokens >= 0 ? promptTokens : 0,
      cost: null,
    },
  };
}
export function createDecisionBatches(texts: string[], batchSize: number, systemPrompt?: string, question?: string): string[][] {
  const batches: string[][] = [];
  const limit = normalizeBatchSize(batchSize);
  let batch: string[] = [];
  for (const text of texts) {
    if (encoder.encode(JSON.stringify(buildDecisionRequest([text], systemPrompt, JEV_MODEL, question))).length > MAX_QUESTION_BYTES) {
      throw new Error("单条弹幕超过 Jev 输入预算，已停止分析，请检查弹幕源。");
    }
    if (batch.length >= limit) {
      batches.push(batch);
      batch = [];
    }
    batch.push(text);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** 缺项/类型错误直接报错，不能把解析失败当作“所有弹幕都有剧透”。 */
export function parseDecisionResponse(data: unknown, texts: string[], fallbackModel = JEV_MODEL): Omit<JevBatchResult, "elapsedMs"> {
  const response = data as {
    answers?: Record<string, { type?: unknown; noul?: unknown }>;
    model?: unknown;
    usage?: { input_tokens?: unknown; cost?: unknown };
  } | null;
  const answers = response?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Error("Jev 返回中缺少 answers，无法读取判定。");
  }
  const items = texts.map((text, index) => {
    const answer = answers[`dm_${index}`];
    const probability = answer?.noul;
    if (answer?.type !== "noul" || typeof probability !== "number" ||
      !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`Jev 第 ${index + 1} 条判定缺失或概率无效，本批未应用。`);
    }
    return { text, probability };
  });
  const input = response?.usage?.input_tokens;
  const cost = response?.usage?.cost;
  return {
    items,
    model: typeof response?.model === "string" ? response.model : fallbackModel,
    usage: {
      inputTokens: typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : 0,
      cost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    },
  };
}

export function abortError(): DOMException { return new DOMException("已停止", "AbortError"); }
export function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }

/** 后台消息未立即返回时也能及时响应取消。 */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function retryDelay(value: string | undefined, attempt: number, now = Date.now()): number {
  if (value) {
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    if (Number.isFinite(ms) && ms >= 0) return Math.max(250, ms);
  }
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

export class JevHttpError extends Error {
  constructor(public status: number) {
    const hints: Record<number, string> = {
      401: "API Key 无效，请确认与接口地址匹配", 402: "账户余额不足", 403: "服务拒绝访问，请检查账户权限",
      404: "Jev 模型或 Decisions 接口不可用", 422: "Jev 请求参数未通过校验",
      413: "请求内容过大，请减小单次请求处理弹幕数量",
      429: "请求被限流，请降低并发数", 503: "Jev 服务暂时不可用", 529: "Jev 服务繁忙",
    };
    super(`Jev HTTP ${status}: ${hints[status] ?? "请求失败，请稍后重试"}`);
  }
}

/** 只走扩展后台的 Decisions API；单批超时包含重试与退避时间。 */
export async function requestDecisions(
  texts: string[], config: JevConfig,
  opts: { signal?: AbortSignal; onRetry?: (info: RetryInfo) => void } = {},
): Promise<JevBatchResult> {
  checkAbort(opts.signal);
  const api = resolveJevApi(config);
  const headers = buildApiHeaders(config);
  const timeoutSeconds = normalizeRequestTimeoutSeconds(config.requestTimeoutSeconds);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSeconds * 1000);
  const started = performance.now();
  try {
    const isOpenAI = normalizeApiMode(config.apiMode) === "openai";
    const body = JSON.stringify(
      isOpenAI
        ? buildOpenAIBatchRequest(texts, config.systemPrompt, api.model, config.filterQuestion)
        : buildDecisionRequest(texts, config.systemPrompt, api.model, config.filterQuestion),
    );
    for (let attempt = 0; ; attempt++) {
      checkAbort(controller.signal);
      const response = await abortable(LFHttp.request(api.endpoint, {
        method: "POST",
        headers,
        credentials: "omit",
        body,
        redirect: "error",
        signal: controller.signal,
        throwOnHTTPError: false,
      }), controller.signal);
      checkAbort(controller.signal);
      if (response.status !== 200) {
        if ([429, 502, 503, 529].includes(response.status) && attempt < 2) {
          const delayMs = retryDelay(response.headers["retry-after"], attempt + 1);
          opts.onRetry?.({ attempt: attempt + 1, delayMs, status: response.status });
          await delay(delayMs, controller.signal);
          continue;
        }
        throw new JevHttpError(response.status);
      }
      let data: unknown;
      try { data = JSON.parse(await response.text()); }
      catch { throw new Error("Jev 返回了无效 JSON，本批未应用。"); }
      checkAbort(controller.signal);
      const parsed = isOpenAI
        ? parseOpenAIBatchResponse(data, texts, api.model)
        : parseDecisionResponse(data, texts, api.model);
      return { ...parsed, elapsedMs: Math.round(performance.now() - started) };
    }
  } catch (error) {
    if (opts.signal?.aborted) throw abortError();
    if (timedOut) throw new Error(`Jev 请求超时（超过 ${timeoutSeconds} 秒，含重试等待）`);
    throw error;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
