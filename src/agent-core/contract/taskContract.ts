import type { TaskContract, TaskType } from "../types";

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
      dependencyChange: "ask",
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

  if (/(deploy|vercel|production|发布|部署)/i.test(objective)) {
    return "deployment";
  }

  if (/(database|supabase|crud|auth|login|orders|backend|api|数据库|登录|后台)/i.test(objective)) {
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

function budgetForTaskType(taskType: TaskType): TaskContract["budget"] {
  switch (taskType) {
    case "answer":
      return {
        maxModelTurns: 2,
        maxToolCalls: 8,
        maxMutations: 0,
        maxRepairCycles: 0,
      };
    case "copy_edit":
    case "style_edit":
    case "component_edit":
      return {
        maxModelTurns: 14,
        maxToolCalls: 30,
        maxMutations: 8,
        maxRepairCycles: 2,
      };
    case "add_page":
    case "backend_feature":
    case "full_site":
      return {
        maxModelTurns: 16,
        maxToolCalls: 52,
        maxMutations: 18,
        maxRepairCycles: 3,
      };
    case "deployment":
      return {
        maxModelTurns: 4,
        maxToolCalls: 12,
        maxMutations: 2,
        maxRepairCycles: 1,
      };
  }
}
