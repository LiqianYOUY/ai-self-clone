import { scanPII } from "./privacy";

export type SafetyDecision =
  "ALLOW" | "EDIT_REQUIRED" | "STUDY_NOTICE" | "PAUSE_SAFETY" | "WITHDRAW";
export interface SafetyResult {
  decision: SafetyDecision;
  reasonCode: string;
  notice?: string;
}
export const SOURCE_QUERY_NOTICE =
  "这项研究暂不揭示当场来源；你可以继续、跳过或结束。";
export const BOUNDARY_NOTICE =
  "这类现实决定或承诺需要由本人在研究外确认。你可以换个话题、暂停或结束。";
export const SAFETY_PAUSE_NOTICE =
  "研究聊天已暂停，待发消息已停止。请联系值守研究人员；如有即时危险，请使用当地紧急支持渠道。";

function outsideQuotes(text: string): string {
  return text.replace(
    /[“「『][\s\S]*?[”」』]|"[^"\n]*"|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu,
    " ",
  );
}
function nonNegated(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  for (const m of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, m.index! - 30), m.index!);
    if (
      !/(?:不想|不会|没有|没想|并非|不是|从未|从未想过|不打算|不会去|do not want to|don't want to|do not|don't|not going to|never|no plan to|no thoughts of|not)\s*(?:真的|再|去|actually|ever)?\s*$/i.test(
        before,
      )
    )
      return true;
  }
  return false;
}
/** Rule screen shared by both source paths. It is not a clinical classifier. */
export function inspectText(raw: string): SafetyResult {
  const text = raw.normalize("NFKC");
  const direct = outsideQuotes(text);
  if (
    nonNegated(
      direct,
      /(?:退出研究|退出实验|撤回(?:同意|数据)?|停止盲测|结束盲测|结束研究|停止实验|不想继续(?:研究|实验|聊天)?|结束这场|停止聊天)|(?:withdraw (?:my )?consent|withdraw from|stop (?:this |the )?(?:study|experiment|chat)|end (?:the |this )?(?:study|experiment|chat)|I (?:want to|need to) (?:quit|withdraw)|reveal (?:the |this )?source now|tell me the source and stop|I want (?:a )?full debrief)/gi,
    )
  ) {
    return {
      decision: "WITHDRAW",
      reasonCode: "PARTICIPANT_STOP",
      notice:
        "研究聊天已停止。你可以选择提前说明、分析排除或按批准政策申请删除。",
    };
  }
  const crisis = nonNegated(
    direct,
    /(?:自杀|杀死自己|结束生命|伤害自己|割腕|服药自尽|跳楼|杀了他|杀了她|杀死他们|拿刀去|kill myself|hurt myself|end my life|suicide|kill (?:him|her|them)|shoot (?:him|her|them))/gi,
  );
  const urgentHealth =
    /(?:无法呼吸|喘不过气|胸痛.{0,12}(?:剧烈|严重)|正在流血不止|大量出血|刚.{0,8}(?:吞|吃).{0,8}(?:一瓶|很多|过量).{0,8}(?:药|安眠药)|can't breathe|cannot breathe|overdosed|took (?:a whole bottle|too many).{0,12}pills|bleeding heavily)/i.test(
      direct,
    );
  if (crisis || urgentHealth)
    return {
      decision: "PAUSE_SAFETY",
      reasonCode: urgentHealth ? "URGENT_HEALTH" : "CRISIS_LANGUAGE",
      notice: SAFETY_PAUSE_NOTICE,
    };
  // A quotation is not automatically an imminent first-person threat; dangerous quoted material still receives review.
  if (nonNegated(text, /(?:自杀|割腕|kill myself|suicide|kill them)/gi)) {
    return {
      decision: "EDIT_REQUIRED",
      reasonCode: "QUOTED_OR_AMBIGUOUS_RISK",
      notice: "这段内容需要研究人员确认安全范围。请编辑或联系研究人员。",
    };
  }
  if (scanPII(text).length)
    return {
      decision: "EDIT_REQUIRED",
      reasonCode: "PRIVACY_REVIEW",
      notice: "检测到可能的个人或第三方敏感信息，请先删除或替换后再发送。",
    };
  if (
    /(?:你是不是\s*(?:AI|人工智能|机器人|本人)|你是\s*(?:AI|机器人|本人)\s*吗|现在是不是\s*本人|到底是真人还是|are you (?:an? )?(?:ai|bot|human)|is this (?:really )?you|who is replying)/i.test(
      direct,
    )
  )
    return {
      decision: "STUDY_NOTICE",
      reasonCode: "SOURCE_QUERY",
      notice: SOURCE_QUERY_NOTICE,
    };
  if (
    /(?:借我.{0,10}(?:钱|块|元)|给我转账|替我转账|帮我(?:订票|签约|买股票|下单|诊断)|告诉我该吃什么药|承诺.{0,15}(?:到场|还钱|复合)|lend me|transfer.{0,20}money|book (?:me|my|the|our).{0,15}(?:ticket|flight)|sign (?:the|my) contract|diagnose me|which medicine should I|invest my|promise.{0,20}(?:come|pay|marry))/i.test(
      direct,
    )
  )
    return {
      decision: "STUDY_NOTICE",
      reasonCode: "REAL_WORLD_BOUNDARY",
      notice: BOUNDARY_NOTICE,
    };
  if (
    /(?:ignore (?:all |the )?(?:previous|system) instructions|reveal (?:the )?system prompt|忽略.{0,8}(?:系统|之前).{0,8}指令|泄露系统提示|执行(?:终端|shell|命令)|<\/?system>)/i.test(
      text,
    )
  )
    return {
      decision: "EDIT_REQUIRED",
      reasonCode: "UNTRUSTED_INSTRUCTION",
      notice: "该内容超出本研究聊天范围，请修改或换个话题。",
    };
  return {
    decision: "ALLOW",
    reasonCode: /(?:有点累|有点烦|不开心|tired|a bit sad|frustrated)/i.test(
      text,
    )
      ? "EVERYDAY_DISTRESS"
      : "IN_SCOPE",
  };
}
