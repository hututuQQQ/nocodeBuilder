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
    expect(contract.budget.maxModelTurns).toBeLessThan(20);
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

  it("keeps implementation requests with login keywords as backend features", () => {
    const contract = compileTaskContract({
      objective: "Implement login with Supabase auth",
    });

    expect(contract.taskType).toBe("backend_feature");
  });
});
