import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

type Manifest = {
  caseNumber: string;
  objects: Array<{ key: string; file: string }>;
  staleR2Keys?: string[];
};

type PublishState = {
  r2Keys: string[];
  d1Batches: string[];
};

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? "unknown"})\n${output.slice(-4000)}`));
    });
  });
}

async function main() {
  const caseNumber = (readFlag("--case") || "1176").replace(/^FC/i, "");
  const dataDir = path.resolve(readFlag("--data-dir") || ".rag-data");
  const outputDir = path.join(dataDir, "cloud", `FC${caseNumber}`);
  const manifest = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8")) as Manifest;
  const stateFile = path.join(outputDir, "publish-state.json");
  const bucket = readFlag("--bucket") || "psc-docket-assistant-documents";
  const database = readFlag("--database") || "DB";
  const concurrency = Math.max(1, Math.min(8, Number(readFlag("--concurrency") || 4)));

  let state: PublishState = { r2Keys: [], d1Batches: [] };
  try {
    state = JSON.parse(await fs.readFile(stateFile, "utf8")) as PublishState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const uploaded = new Set(state.r2Keys);
  const imported = new Set(state.d1Batches);

  if (!hasFlag("--skip-r2")) {
    for (const key of manifest.staleR2Keys || []) {
      await run("npx", ["wrangler", "r2", "object", "delete", `${bucket}/${key}`, "--remote"]);
      console.log(`Removed stale R2 object ${key}`);
    }
    const pending = manifest.objects.filter(item => !uploaded.has(item.key));
    for (let start = 0; start < pending.length; start += concurrency) {
      const batch = pending.slice(start, start + concurrency);
      await Promise.all(batch.map(item => run("npx", [
        "wrangler", "r2", "object", "put", `${bucket}/${item.key}`,
        "--remote", "--file", item.file,
        "--content-type", "text/html; charset=utf-8",
        "--content-encoding", "gzip"
      ])));
      for (const item of batch) uploaded.add(item.key);
      state.r2Keys = [...uploaded];
      await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
      console.log(`R2 ${uploaded.size}/${manifest.objects.length}`);
    }
  }

  if (!hasFlag("--skip-d1")) {
    const sqlDir = path.join(outputDir, "sql");
    const sqlFiles = (await fs.readdir(sqlDir)).filter(name => name.endsWith(".sql")).sort();
    for (const filename of sqlFiles) {
      if (imported.has(filename)) continue;
      await run("npx", ["wrangler", "d1", "execute", database, "--remote", "--file", path.join(sqlDir, filename), "--yes"]);
      imported.add(filename);
      state.d1Batches = [...imported];
      await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
      console.log(`D1 ${imported.size}/${sqlFiles.length}`);
    }
  }

  console.log(`Published ${manifest.caseNumber}: ${uploaded.size} R2 objects and ${imported.size} D1 batches.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
