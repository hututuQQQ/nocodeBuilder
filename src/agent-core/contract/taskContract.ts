import type { TaskContract, TaskType } from "../types";
import { AGENT_TASK_BUDGETS } from "../budget/agentBudget";

const DEFAULT_ALLOWED_PATHS = [
  "app/**",
  "components/**",
  "lib/**",
  "data/**",
  "public/**",
  "styles/**",
  "package.json",
  "next.config.*",
  "postcss.config.*",
  "tailwind.config.*",
  "tsconfig.json",
  "vercel.json",
  "middleware.ts",
];

const DEFAULT_FORBIDDEN_PATHS = [
  ".aibuilder/**",
  ".env",
  ".env.*",
  "node_modules/**",
  ".git/**",
  "dist/**",
  ".next/**",
];

export function compileTaskContract({
  objective,
  selectedSiteNodeId,
  taskType,
}: {
  objective: string;
  selectedSiteNodeId?: string | null;
  taskType?: TaskType;
}): TaskContract {
  const normalizedObjective = objective.trim();

  if (!normalizedObjective) {
    throw new Error("TaskContract objective is required.");
  }

  const resolvedTaskType = taskType ?? inferTaskType(normalizedObjective);

  return validateTaskContract({
    objective: normalizedObjective,
    taskType: resolvedTaskType,
    scope: {
      componentIds: selectedSiteNodeId ? [selectedSiteNodeId] : undefined,
      allowedPaths: DEFAULT_ALLOWED_PATHS,
      forbiddenPaths: DEFAULT_FORBIDDEN_PATHS,
    },
    acceptanceCriteria: [
      {
        id: "request-addressed",
        description: "The user's request is addressed without expanding scope.",
        required: true,
      },
      {
        id: "verifier-passed",
        description: "The external verifier produced a passed report.",
        required: true,
      },
    ],
    permissions: {
      fileWrite: resolvedTaskType !== "answer",
      dependencyChange: "allow",
      fileDelete: "ask",
      databaseChange: resolvedTaskType === "backend_feature" ? "ask" : "deny",
      previewDeployment: "ask",
      productionDeployment: "ask",
    },
    budget: budgetForTaskType(resolvedTaskType),
  });
}

export function validateTaskContract(contract: TaskContract): TaskContract {
  if (!contract.objective.trim()) {
    throw new Error("TaskContract objective is required.");
  }

  if (!contract.scope.allowedPaths.length) {
    throw new Error("TaskContract must include allowedPaths.");
  }

  if (!contract.scope.forbiddenPaths.length) {
    throw new Error("TaskContract must include forbiddenPaths.");
  }

  if (contract.budget.maxModelTurns < 1 || contract.budget.maxToolCalls < 1) {
    throw new Error("TaskContract budget must be positive.");
  }

  if (contract.permissions.productionDeployment !== "ask") {
    throw new Error("Production deployment must always ask.");
  }

  return contract;
}

function inferTaskType(objective: string): TaskType {
  const text = objective.toLowerCase();

  if (hasExplicitReadOnlyIntent(objective)) {
    return "answer";
  }

  if (/(deploy|vercel|production|发布|部署)/i.test(objective)) {
    return "deployment";
  }

  if (isLocationLookupQuestion(objective, text)) {
    return "answer";
  }

  if ((hasImplementationIntent(objective) || hasBugOrFailureIntent(objective)) && hasBackendFeatureIntent(objective)) {
    return "backend_feature";
  }

  if (isReadOnlyQuestion(objective, text)) {
    return "answer";
  }

  if (hasBugOrFailureIntent(objective)) {
    return hasBackendFeatureIntent(objective) ? "backend_feature" : "component_edit";
  }

  if (/(database|supabase|crud|auth|login|orders|backend|api|server|server-side|multiplayer|multi-player|online|realtime|real-time|websocket|room|rooms|\u540e\u7aef|\u670d\u52a1\u7aef|\u6570\u636e\u5e93|\u63a5\u53e3|\u8054\u673a|\u591a\u4eba|\u5b9e\u65f6|\u623f\u95f4|数据库|登录|后台)/i.test(objective)) {
    return "backend_feature";
  }

  if (/(new page|add page|route|页面|新增页)/i.test(objective)) {
    return "add_page";
  }

  if (/(color|theme|style|visual|layout|font|颜色|样式|布局)/i.test(objective)) {
    return "style_edit";
  }

  if (/(copy|text|wording|headline|文案|文字|标题)/i.test(objective)) {
    return "copy_edit";
  }

  if (/(question|explain|why|how|status|什么|为什么|如何)/i.test(objective)) {
    return "answer";
  }

  if (text.length > 180 || /(build|create|generate|生成|创建|完整)/i.test(objective)) {
    return "full_site";
  }

  return "component_edit";
}

function isLocationLookupQuestion(objective: string, lowerObjective: string) {
  return (
    /(where\s+(is|are|can)|can'?t\s+find|cannot\s+find|location|entry)/i.test(lowerObjective) ||
    /(\u54ea\u91cc|\u5728\u54ea|\u627e\u4e0d\u5230|\u6ca1\u6709\u627e\u5230|\u5165\u53e3)/u.test(objective)
  ) && !hasImplementationIntent(objective);
}

function isReadOnlyQuestion(objective: string, lowerObjective: string) {
  if (hasExplicitReadOnlyIntent(objective)) {
    return true;
  }

  if (hasBugOrFailureIntent(objective)) {
    return false;
  }

  if (hasImplementationIntent(objective)) {
    return false;
  }

  const asksForInformation =
    /(question|explain|why|status|what\s+is|where\s+(is|are|can)|is\s+there|do\s+we\s+have|does\s+.*\s+have|currently|right\s+now|can'?t\s+find|cannot\s+find|not\s+found)/i.test(lowerObjective) ||
    /(\u4ec0\u4e48|\u4e3a\u4ec0\u4e48|\u5982\u4f55|\u600e\u4e48|\u54ea\u91cc|\u5728\u54ea|\u6709\u6ca1\u6709|\u662f\u5426|\u76ee\u524d|\u5f53\u524d|\u73b0\u5728|\u627e\u4e0d\u5230|\u6ca1\u6709\u627e\u5230)/u.test(objective);

  if (asksForInformation) {
    return true;
  }

  if (/(^|\b)(answer|reply|respond)\b|回答|回复/i.test(objective)) {
    return true;
  }

  if (hasImplementationIntent(objective)) {
    return false;
  }

  return /(\?|\u5417|\u4e48)/u.test(objective);
}

function hasImplementationIntent(objective: string) {
  return /(add|create|build|implement|fix|update|change|modify|remove|delete|wire|integrate|generate|\u65b0\u589e|\u6dfb\u52a0|\u521b\u5efa|\u5b9e\u73b0|\u4fee\u590d|\u4fee\u6539|\u6539\u6210|\u5220\u9664|\u63a5\u5165|\u96c6\u6210|\u751f\u6210|\u6784\u5efa|\u52a0\u4e00\u4e2a|\u505a\u4e00\u4e2a|\u80fd\u4e0d\u80fd.*(\u52a0|\u6dfb\u52a0|\u5b9e\u73b0|\u505a|\u521b\u5efa|\u63a5\u5165|\u96c6\u6210)|\u5e2e\u6211.*(\u52a0|\u6dfb\u52a0|\u5b9e\u73b0|\u505a|\u521b\u5efa|\u63a5\u5165|\u96c6\u6210)|\u662f\u5426\u53ef\u4ee5.*(\u5b9e\u73b0|\u6dfb\u52a0|\u63a5\u5165|\u96c6\u6210)|\u53ef\u4e0d\u53ef\u4ee5.*(\u5b9e\u73b0|\u6dfb\u52a0|\u63a5\u5165|\u96c6\u6210))/i.test(objective);
}

function hasBackendFeatureIntent(objective: string) {
  if (/\b(register|registration)\b/i.test(objective)) {
    return true;
  }

  return /(database|supabase|crud|auth|login|sign in|signup|orders|backend|api|server|server-side|multiplayer|multi-player|online|realtime|real-time|websocket|room|rooms|\u540e\u7aef|\u670d\u52a1\u7aef|\u6570\u636e\u5e93|\u63a5\u53e3|\u8054\u673a|\u591a\u4eba|\u5b9e\u65f6|\u623f\u95f4|\u767b\u5f55|\u6ce8\u518c|\u8ba4\u8bc1|\u540e\u53f0|鏁版嵁搴搢鐧诲綍|鍚庡彴)/i.test(objective);
}

export function hasExplicitReadOnlyIntent(objective: string): boolean {
  return /(only explain|explain only|no changes|do not change|don't change|do not modify|don't modify|just tell me|read.?only|只解释|不要改|不要修改|只分析|只告诉|别改)/i.test(objective);
}

export function hasBugOrFailureIntent(objective: string): boolean {
  return /(error|failed|failure|broken|bug|crash|exception|stack trace|not working|cannot|can't|build failed|runtime error|preview broken|white screen|null value|violates|constraint|foreign key|duplicate key|relation does not exist|column does not exist|rls|permission denied|注册不了|登录不了|不能用|报错|失败|崩溃|白屏|无法|有.?bug|不生效)/i.test(objective);
}

export function hasRepairIntent(objective: string): boolean {
  return hasBugOrFailureIntent(objective) || hasImplementationIntent(objective);
}

function budgetForTaskType(taskType: TaskType): TaskContract["budget"] {
  return { ...AGENT_TASK_BUDGETS[taskType] };
}
