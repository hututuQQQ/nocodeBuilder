import { describe, expect, it } from "vitest";
import { compileTaskContract, validateTaskContract } from "./taskContract";

describe("TaskContract", () => {
  it("infers task type and bounded budgets", () => {
    const contract = compileTaskContract({
      objective: "Update the homepage hero color",
      selectedSiteNodeId: "home.hero",
    });

    expect(contract.taskType).toBe("style_edit");
    expect(contract.scope.componentIds).toEqual(["home.hero"]);
    expect(contract.budget.maxModelTurns).toBeGreaterThan(1);
    expect(contract.budget.maxModelTurns).toBe(28);
  });

  it("requires production deployment approval", () => {
    const contract = compileTaskContract({ objective: "Deploy to production" });

    expect(contract.taskType).toBe("deployment");
    expect(contract.permissions.productionDeployment).toBe("ask");
    expect(() =>
      validateTaskContract({
        ...contract,
        permissions: {
          ...contract.permissions,
          productionDeployment: "deny" as "ask",
        },
      }),
    ).toThrow(/Production deployment/);
  });

  it("allows dependency changes by default while keeping risky actions guarded", () => {
    const contract = compileTaskContract({ objective: "Build a complete landing page" });

    expect(contract.permissions.dependencyChange).toBe("allow");
    expect(contract.permissions.fileDelete).toBe("ask");
    expect(contract.permissions.databaseChange).toBe("deny");
    expect(contract.permissions.productionDeployment).toBe("ask");
  });

  it("treats multiplayer and realtime work as backend features", () => {
    const contract = compileTaskContract({
      objective: "Implement multiplayer room realtime sync for online poker",
    });

    expect(contract.taskType).toBe("backend_feature");
    expect(contract.permissions.databaseChange).toBe("ask");
  });

  it("treats login entry status questions as read-only answers", () => {
    const contract = compileTaskContract({
      objective: "\u76ee\u524d\u6709\u767b\u5f55\u5165\u53e3\u5417\uff0c\u6211\u6ca1\u6709\u627e\u5230",
    });

    expect(contract.taskType).toBe("answer");
    expect(contract.permissions.fileWrite).toBe(false);
    expect(contract.permissions.databaseChange).toBe("deny");
  });

  it("does not let login keywords override location questions", () => {
    const contract = compileTaskContract({
      objective: "Where is the login entry? I cannot find it.",
    });

    expect(contract.taskType).toBe("answer");
  });

  it("treats login enabled questions as read-only answers", () => {
    const contract = compileTaskContract({
      objective: "Is login enabled?",
    });

    expect(contract.taskType).toBe("answer");
  });

  it("keeps question-shaped implementation requests as backend features", () => {
    const contract = compileTaskContract({
      objective: "Can you add login with Supabase auth?",
    });

    expect(contract.taskType).toBe("backend_feature");
  });

  it("keeps Chinese login location questions as read-only answers", () => {
    expect(compileTaskContract({
      objective: "\u767b\u5f55\u5165\u53e3\u5728\u54ea\uff1f",
    }).taskType).toBe("answer");
    expect(compileTaskContract({
      objective: "\u76ee\u524d\u6709\u767b\u5f55\u5165\u53e3\u5417\uff1f",
    }).taskType).toBe("answer");
  });

  it("treats Chinese implementation-shaped backend questions as backend features", () => {
    const objectives = [
      "\u73b0\u5728\u80fd\u4e0d\u80fd\u52a0\u767b\u5f55\uff1f",
      "\u662f\u5426\u53ef\u4ee5\u5b9e\u73b0 Supabase \u767b\u5f55\uff1f",
      "\u80fd\u4e0d\u80fd\u505a\u4e00\u4e2a\u591a\u4eba\u623f\u95f4\u5b9e\u65f6\u540c\u6b65\uff1f",
      "\u76ee\u524d\u5e2e\u6211\u52a0\u4e00\u4e2a\u767b\u5f55\u5165\u53e3\u5427",
    ];

    for (const objective of objectives) {
      expect(compileTaskContract({ objective }).taskType).toBe("backend_feature");
    }
  });

  it("keeps implementation requests with login keywords as backend features", () => {
    const contract = compileTaskContract({
      objective: "Implement login with Supabase auth",
    });

    expect(contract.taskType).toBe("backend_feature");
  });
});
