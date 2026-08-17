import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capabilityKey,
  commandCheck,
  createPreflightReceipt,
  normalizeCapabilityReports,
  PreflightError,
  publishAtomicBatch,
  runLocalPreflightChecks,
  validatePreflightReceipt,
} from "./preflight.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rejects(code, run) {
  try {
    await run();
  } catch (error) {
    assert(
      error instanceof PreflightError,
      `expected PreflightError, got ${error}`,
    );
    assert(error.code === code, `expected ${code}, got ${error.code}`);
    return;
  }
  throw new Error(`expected ${code}`);
}

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "todo-preflight-"));

try {
  const successfulCommand = path.join(temporaryRoot, "successful-command.mjs");
  const successfulOutput = `ready\0\r\n${"multiline   stdout\n".repeat(80)}`;
  writeFileSync(
    successfulCommand,
    `process.stdout.write(${JSON.stringify(successfulOutput)});\n`,
    "utf8",
  );
  const successfulCheck = commandCheck(
    process.execPath,
    [successfulCommand],
    temporaryRoot,
  );
  assert(successfulCheck.status === "ok", "successful command check failed");
  assert(
    successfulCheck.summary.length <= 500 &&
      !/[\0\r\n]/u.test(successfulCheck.summary),
    "successful command summary was not bounded to one line",
  );

  const failedCommand = path.join(temporaryRoot, "failed-command.mjs");
  const failedOutput = `failed\0\r\n${"multiline   stderr\n".repeat(80)}`;
  writeFileSync(
    failedCommand,
    `process.stderr.write(${JSON.stringify(failedOutput)});\nprocess.exit(7);\n`,
    "utf8",
  );
  const failedCheck = commandCheck(
    process.execPath,
    [failedCommand],
    temporaryRoot,
  );
  assert(failedCheck.status === "failed", "failed command check passed");
  assert(
    failedCheck.summary.length <= 500 &&
      !/[\0\r\n]/u.test(failedCheck.summary),
    "failed command summary was not bounded to one line",
  );

  const firebaseRead = {
    connector: "Firebase-Crashlytics",
    scope: "mega-farm-487811",
    access: "read",
  };
  const reports = normalizeCapabilityReports([
    { ...firebaseRead, status: "ok", summary: "Known issue fetched" },
    { ...firebaseRead, ok: true },
    {
      connector: "jira",
      scope: "gameboxapps.atlassian.net/MF",
      access: "write",
      required: false,
      status: "interactive_required",
    },
  ]);
  assert(reports.length === 2, "capability reports were not deduplicated");
  assert(
    reports[0].connector <= reports[1].connector,
    "capability reports were not deterministic",
  );
  await rejects("invalid_input", () =>
    normalizeCapabilityReports([
      { ...firebaseRead, status: "ok", rawResponse: { secret: true } },
    ]),
  );

  const calls = [];
  const localPreflight = await runLocalPreflightChecks(
    [
      {
        name: "git-root",
        run: ({ repoRoot }) => {
          calls.push("git-root");
          return { status: existsSync(repoRoot) ? "ok" : "failed" };
        },
      },
      {
        name: "optional-check",
        required: false,
        run: () => {
          calls.push("optional-check");
          throw new Error("optional failure");
        },
      },
    ],
    { repoRoot: temporaryRoot },
  );
  assert(localPreflight.ok, "optional local failure blocked preflight");
  assert(
    calls.join(",") === "git-root,optional-check",
    "local checks changed order",
  );

  const config = { workers: 4, retries: 0 };
  const now = 1_800_000_000_000;
  const receipt = createPreflightReceipt({
    repoRoot: temporaryRoot,
    config,
    capabilityReports: reports,
    localPreflight,
    ttlMs: 5000,
    now,
  });
  assert(
    !JSON.stringify(receipt).includes("Known issue fetched") &&
      !JSON.stringify(receipt).includes("optional failure"),
    "receipt retained probe output",
  );
  validatePreflightReceipt(receipt, {
    repoRoot: temporaryRoot,
    config,
    requiredCapabilities: [firebaseRead],
    now: now + 1000,
  });
  await rejects("capability_missing", () =>
    validatePreflightReceipt(receipt, {
      repoRoot: temporaryRoot,
      config,
      requiredCapabilities: [
        {
          connector: "jira",
          scope: "gameboxapps.atlassian.net/MF",
          access: "write",
        },
      ],
      now: now + 1000,
    }),
  );
  await rejects("receipt_binding_mismatch", () =>
    validatePreflightReceipt(receipt, {
      repoRoot: temporaryRoot,
      config: { ...config, workers: 8 },
      now: now + 1000,
    }),
  );
  await rejects("expired_receipt", () =>
    validatePreflightReceipt(receipt, {
      repoRoot: temporaryRoot,
      config,
      now: now + 5000,
    }),
  );
  await rejects("interactive_required", () =>
    createPreflightReceipt({
      repoRoot: temporaryRoot,
      config,
      capabilityReports: [
        { ...firebaseRead, access: "write", status: "interactive_required" },
      ],
      now,
    }),
  );

  let sequenceTouched = false;
  const invalidDestination = path.join(temporaryRoot, "invalid-batch");
  await rejects("invalid_batch", () =>
    publishAtomicBatch({
      inputs: [{ title: "valid" }, { title: "invalid" }],
      validateInput: (input) => input.title !== "invalid",
      reserve: () => {
        sequenceTouched = true;
        return [];
      },
      destinationDir: invalidDestination,
    }),
  );
  assert(!sequenceTouched, "sequence was touched before all inputs validated");
  assert(!existsSync(invalidDestination), "invalid batch became visible");

  const failedDestination = path.join(temporaryRoot, "failed-batch");
  await (async () => {
    try {
      await publishAtomicBatch({
        inputs: [{ title: "one" }, { title: "two" }],
        validateInput: (input) => input,
        reserve: () => {
          sequenceTouched = true;
          return {
            value: { first: 41, last: 42 },
            files: [
              { relativePath: "blocked", content: "file" },
              { relativePath: "blocked/task.md", content: "nested" },
            ],
          };
        },
        destinationDir: failedDestination,
      });
    } catch {
      return;
    }
    throw new Error("expected staging failure");
  })();
  assert(sequenceTouched, "reserve callback was not called after validation");
  assert(!existsSync(failedDestination), "failed staged batch became visible");
  assert(
    !readdirSync(temporaryRoot).some((name) => name.includes(".tmp-")),
    "staged temp files were not rolled back",
  );

  const destination = path.join(temporaryRoot, "published-batch");
  const published = await publishAtomicBatch({
    inputs: [{ title: "one" }, { title: "two" }],
    validateInput: (input) => ({ ...input, title: input.title.toUpperCase() }),
    reserve: (inputs) => ({
      value: { first: 43, last: 44 },
      files: inputs.map((input, index) => ({
        relativePath: `${43 + index}-${input.title.toLowerCase()}.md`,
        content: `${input.title}\n`,
      })),
    }),
    destinationDir: destination,
  });
  assert(
    published.files.length === 2 &&
      published.reservation.first === 43 &&
      readFileSync(path.join(destination, "43-one.md"), "utf8") === "ONE\n",
    "batch was not published",
  );
  assert(
    capabilityKey(firebaseRead) ===
      capabilityKey({ ...firebaseRead, connector: "firebase-crashlytics" }),
    "capability identity was not normalized",
  );

  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      capabilityReports: reports.length,
      receiptBound: true,
      rawResponsesStored: false,
      atomicBatchFiles: published.files.length,
    })}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
