import type { AiProviderConfig } from "../services/keyStore";
import type { SpecBlockDiagnosis } from "../spec-core/blockTriage";
import type {
  DevelopmentSpec,
  SpecRevision,
  SpecStatus,
} from "../spec-core/types";

export type SpecUserIntent =
  | "ask_question"
  | "request_revision"
  | "approve_and_run"
  | "add_implementation_note"
  | "diagnose_block"
  | "retry_with_note"
  | "switch_to_chat"
  | "cancel"
  | "unknown";

export async function routeSpecUserMessage(input: {
  message: string;
  spec: DevelopmentSpec | null;
  currentRevision?: SpecRevision | null;
  conversationMessages: Array<{ role: string; content: string }>;
  status: SpecStatus | null;
  blockDiagnosis?: SpecBlockDiagnosis | null;
  config: AiProviderConfig;
}): Promise<{
  intent: SpecUserIntent;
  confidence: number;
  answer?: string;
  revisionFeedback?: string;
  retryNote?: string;
  implementationNote?: string;
}> {
  void input.config;
  void input.conversationMessages;

  const message = input.message.trim();
  const normalized = normalize(message);
  const status = input.status;

  if (!message) {
    return { intent: "unknown", confidence: 0 };
  }

  if (hasCancelIntent(normalized)) {
    return { intent: "cancel", confidence: 0.86 };
  }

  if (hasSwitchToChatIntent(normalized)) {
    return { intent: "switch_to_chat", confidence: 0.9 };
  }

  if (status === "blocked") {
    if (hasDiagnoseIntent(normalized)) {
      return {
        intent: "diagnose_block",
        confidence: 0.92,
        answer: formatBlockDiagnosis(input.blockDiagnosis),
      };
    }

    if (hasRetryIntent(normalized)) {
      return {
        intent: "retry_with_note",
        confidence: 0.9,
        retryNote: message,
      };
    }

    if (hasRevisionIntent(normalized)) {
      return {
        intent: "request_revision",
        confidence: 0.86,
        revisionFeedback: message,
      };
    }
  }

  if (status === "review") {
    if (hasApproveIntent(normalized)) {
      return { intent: "approve_and_run", confidence: 0.93 };
    }

    if (hasQuestionIntent(normalized) && !hasRevisionIntent(normalized)) {
      return { intent: "ask_question", confidence: 0.76 };
    }

    if (hasImplementationNoteIntent(normalized, input.currentRevision)) {
      return {
        intent: "add_implementation_note",
        confidence: 0.78,
        implementationNote: message,
      };
    }

    if (hasRevisionIntent(normalized) || looksLikeChangeRequest(normalized)) {
      return {
        intent: "request_revision",
        confidence: 0.86,
        revisionFeedback: message,
      };
    }
  }

  if (status === "building" || status === "approved") {
    if (hasDiagnoseIntent(normalized)) {
      return { intent: "diagnose_block", confidence: 0.72 };
    }

    if (hasRevisionIntent(normalized) || looksLikeChangeRequest(normalized)) {
      return {
        intent: "request_revision",
        confidence: 0.7,
        revisionFeedback: message,
      };
    }

    if (hasRetryIntent(normalized)) {
      return {
        intent: "retry_with_note",
        confidence: 0.72,
        retryNote: message,
      };
    }

    return {
      intent: "add_implementation_note",
      confidence: 0.68,
      implementationNote: message,
    };
  }

  if (hasQuestionIntent(normalized)) {
    return { intent: "ask_question", confidence: 0.65 };
  }

  return {
    intent: "unknown",
    confidence: 0.2,
    answer:
      "我还不确定这条消息要触发哪种 Spec 行为。你可以说明是要修改方案、开始执行、诊断失败、重试，还是切回 Chat。",
  };
}

function normalize(message: string) {
  return message.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasApproveIntent(message: string) {
  return /(approve|approved|start|run|execute|go ahead|looks good|ok|okay|no problem|没问题|开始做|开始执行|就这样|按这个来|可以执行|通过|批准)/i.test(message);
}

function hasQuestionIntent(message: string) {
  return /(\?|？|why|what|how|explain|where|怎么看|为什么|什么|如何|怎么|哪里|解释|说明|原因)/i.test(message);
}

function hasRevisionIntent(message: string) {
  return /(revise|revision|change plan|update spec|modify spec|改方案|换做法|修改方案|调整方案|修订|改成|换成|不要|别|新增|添加|删除|移除|改一下|改为)/i.test(message);
}

function looksLikeChangeRequest(message: string) {
  return /(change|modify|replace|add|remove|use|make|turn .* into|改|换|加|用|做成|实现|支持|接入)/i.test(message);
}

function hasImplementationNoteIntent(
  message: string,
  revision?: SpecRevision | null,
) {
  return /(note|注意|实现时|开发时|记得|保持|保留|不要影响|约束|补充)/i.test(message) ||
    Boolean(revision?.requirements.unresolvedQuestions.length);
}

function hasDiagnoseIntent(message: string) {
  return /(diagnose|why.*fail|failure reason|what failed|why.*not|why.*stuck|not.*continue|stuck|哪里错|为什么失败|为什么.*没|没有继续|不继续|卡住|看看原因|看原因|诊断|失败原因|哪里失败|哪儿错)/i.test(message);
}

function hasRetryIntent(message: string) {
  return /(retry|rerun|run again|try again|fix.*fail|failed run|sync.*state|continue.*task|continue execution|重试|再跑|再试|重新跑|重新执行|再执行一次|继续.*任务|同步.*状态)/i.test(message);
}

function hasSwitchToChatIntent(message: string) {
  return /(switch.*chat|chat mode|continue in chat|别走 spec|切 chat|切回 chat|换到 chat|普通聊天|不要 spec)/i.test(message);
}

function hasCancelIntent(message: string) {
  return /(cancel|stop|abort|取消|停止|中止|别做了)/i.test(message);
}

function formatBlockDiagnosis(diagnosis?: SpecBlockDiagnosis | null) {
  if (!diagnosis) {
    return "这个 Spec 已阻塞，但目前还没有记录到诊断结果。我会先做 block triage，再给出恢复建议。";
  }

  return [
    `Block kind: ${diagnosis.kind}`,
    diagnosis.summary,
    `Recovery plan: ${diagnosis.recommendedPlan.action}`,
  ].join("\n");
}
