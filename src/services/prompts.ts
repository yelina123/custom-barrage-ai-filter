/** 共享上下文、过滤规则和逐条判断问题集中管理；规则模式下提示词由规则列表自动生成。 */

export const MAX_RULES = 256;

/** 默认规则：剧透过滤（新用户首次安装时的唯一一条规则）。 */
export const DEFAULT_RULES: string[] = [
  "涉及视频剧情剧透：提前告知或暗示视频后续才会呈现的内容、过程、结果或结论（例如结局、凶手、反转、人物生死等），改变观众对当前内容的理解、提前消除悬念或意外感；仅讨论当前或此前已呈现的信息、表达感受、评价或推测不属于剧透。",
];

const INTRO = [
  "你是一个B站弹幕AI过滤器，用于按照用户给出的规则过滤弹幕。",
  "你看不到视频，只能根据单条弹幕的文字内容进行判断。",
].join("\n");

/** 由规则列表自动生成系统提示词：命中任意一条即屏蔽。 */
export function buildSystemPrompt(rules: string[]): string {
  const list = normalizeRules(rules);
  if (list.length === 0) {
    return `${INTRO}\n当前没有设置任何过滤规则，所有弹幕都应当正常显示，无论弹幕内容是什么，概率一律为 0。`;
  }
  const numbered = list.map((rule, index) => `规则${index + 1}：${rule}`).join("\n");
  const verdict = list.length === 1
    ? "判定要求：弹幕内容符合上述规则时，就应当被屏蔽，概率接近 1；不符合时，应当正常显示，概率接近 0。不要因为规则之外的内容屏蔽弹幕。"
    : "判定要求：弹幕内容符合以上任意一条规则时，就应当被屏蔽，概率接近 1；不符合任何一条规则时，应当正常显示，概率接近 0。只要命中任意一条即可，不需要同时满足多条，也不要因为规则之外的内容屏蔽弹幕。";
  return `${INTRO}\n需要过滤的规则如下：\n${numbered}\n\n${verdict}`;
}

/** 规则模式下逐条弹幕的判断问题，随规则数量变化措辞。 */
export function buildQuestion(ruleCount: number): string {
  if (ruleCount <= 0) return "这条弹幕是否应当被过滤？";
  if (ruleCount === 1) return "这条弹幕是否符合上述过滤规则？";
  return "这条弹幕是否符合上述任意一条过滤规则？";
}

export const DEFAULT_SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_RULES);
export const DEFAULT_QUESTION = buildQuestion(DEFAULT_RULES.length);
/** @deprecated 旧名称，等价于 DEFAULT_QUESTION，保留给外部引用。 */
export const JEV_QUESTION = DEFAULT_QUESTION;
export const JEV_POLICY_VERSION = "custom-filter-v4";

/** 规则数组归一：逐项 trim、丢弃空规则、去重保序、最多 256 条。 */
export function normalizeRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const rule = item.trim();
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    out.push(rule);
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

export function normalizeSystemPrompt(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SYSTEM_PROMPT;
}

export function normalizeQuestion(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_QUESTION;
}

export function normalizePromptMode(value: unknown): "rules" | "manual" {
  return value === "manual" ? "manual" : "rules";
}
