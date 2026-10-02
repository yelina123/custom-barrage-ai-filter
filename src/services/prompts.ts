/** 共享上下文和逐条判断问题集中管理；instructions 保持直接、明确的是非问题。 */
export const DEFAULT_SYSTEM_PROMPT = `你是一个B站弹幕AI过滤器，用于过滤掉那些符合用户指定过滤条件的弹幕。
你看不到视频，只能根据单条弹幕的文字，结合下方给出的过滤规则判断这条弹幕是否应当被过滤。
请严格按照用户给出的过滤规则进行判断：符合过滤条件、应当被屏蔽的弹幕概率接近 1，不符合过滤条件、应当正常显示的弹幕概率接近 0。
如果用户没有给出额外规则，则按默认规则处理：过滤涉及视频剧情的剧透弹幕，即提前告知或暗示后续会呈现的内容、过程、结果或结论，改变观众对当前内容的理解、提前消除悬念或意外感的弹幕；仅讨论当前或此前已呈现的信息、表达感受评价或推测的弹幕不属于剧透。`;

/** 逐条弹幕的是非问题，与系统提示词配合决定“过滤什么内容”。 */
export const DEFAULT_QUESTION = "这条弹幕是否符合应当被过滤的条件？";
/** @deprecated 旧名称，等价于 DEFAULT_QUESTION，保留给外部引用。 */
export const JEV_QUESTION = DEFAULT_QUESTION;
export const JEV_POLICY_VERSION = "custom-filter-v3";

export function normalizeSystemPrompt(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SYSTEM_PROMPT;
}

export function normalizeQuestion(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_QUESTION;
}
