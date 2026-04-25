import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "../..");

type WorkflowJob = {
  needs?: string | string[];
  steps?: WorkflowStep[];
  with?: Record<string, unknown>;
};

type WorkflowStep = {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

function isWorkflowWithJobs(value: unknown): value is { jobs: Record<string, WorkflowJob> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "jobs" in value &&
    typeof value.jobs === "object" &&
    value.jobs !== null
  );
}

describe("openclaw npm release workflow", () => {
  it("publishes npm without building bundled SSRF proxy binaries", () => {
    const workflowPath = path.join(repoRoot, ".github/workflows/openclaw-npm-release.yml");
    const workflow: unknown = YAML.parse(readFileSync(workflowPath, "utf8"));
    expect(isWorkflowWithJobs(workflow)).toBe(true);
    if (!isWorkflowWithJobs(workflow)) {
      throw new Error("workflow has no jobs map");
    }

    const jobs = workflow.jobs;
    expect(jobs["resolve_caddy_ssrf_version"]).toBeUndefined();
    expect(jobs["build_caddy_ssrf"]).toBeUndefined();
    expect(jobs["publish_openclaw_npm"]?.needs).toEqual(["validate_publish_request"]);
  });
});
