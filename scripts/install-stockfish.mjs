import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const targetDir = path.join(rootDir, "storage", "engines", "stockfish", "current");
const targetBinary = path.join(targetDir, process.platform === "win32" ? "stockfish.exe" : "stockfish");

const releaseTag = process.env.STOCKFISH_RELEASE_TAG ?? "sf_18";
const explicitUrl = process.env.STOCKFISH_DOWNLOAD_URL;

function resolveAssetName() {
  if (process.platform === "darwin" && os.arch() === "arm64") {
    return "stockfish-macos-m1-apple-silicon.tar";
  }

  if (process.platform === "darwin") {
    return "stockfish-macos-x86-64-avx2.tar";
  }

  if (process.platform === "linux" && os.arch() === "x64") {
    return "stockfish-ubuntu-x86-64-avx2.tar";
  }

  if (process.platform === "win32" && os.arch() === "x64") {
    return "stockfish-windows-x86-64-avx2.zip";
  }

  throw new Error(`Unsupported Stockfish target: ${process.platform}/${os.arch()}`);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findBinary(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const nested = await findBinary(fullPath);
      if (nested) {
        return nested;
      }
    }

    if (!entry.isFile()) {
      continue;
    }

    const normalized = entry.name.toLowerCase();
    if (!normalized.startsWith("stockfish")) {
      continue;
    }

    if (normalized.endsWith(".nnue") || normalized.endsWith(".tar") || normalized.endsWith(".zip")) {
      continue;
    }

    return fullPath;
  }

  return null;
}

async function main() {
  if (process.env.CHESS_ANALYZER_SKIP_ENGINE_DOWNLOAD === "1") {
    return;
  }

  if (await exists(targetBinary)) {
    return;
  }

  const assetName = resolveAssetName();
  const downloadUrl =
    explicitUrl ??
    `https://github.com/official-stockfish/Stockfish/releases/download/${releaseTag}/${assetName}`;

  const tmpDir = path.join(rootDir, "storage", "tmp", `stockfish-${Date.now()}`);
  const archivePath = path.join(tmpDir, assetName);
  const extractDir = path.join(tmpDir, "extract");

  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(extractDir, { recursive: true });

  console.log(`Downloading Stockfish from ${downloadUrl}`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Stockfish (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(archivePath, buffer);

  if (assetName.endsWith(".tar")) {
    await execFileAsync("tar", ["-xf", archivePath, "-C", extractDir]);
  } else if (assetName.endsWith(".zip")) {
    await execFileAsync("unzip", ["-q", archivePath, "-d", extractDir]);
  }

  const binarySource = await findBinary(extractDir);
  if (!binarySource) {
    throw new Error("Downloaded archive did not contain a Stockfish binary.");
  }

  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(binarySource, targetBinary);
  await fs.chmod(targetBinary, 0o755);

  await fs.writeFile(
    path.join(targetDir, "metadata.json"),
    JSON.stringify(
      {
        releaseTag,
        assetName,
        downloadedAt: new Date().toISOString()
      },
      null,
      2
    )
  );

  console.log(`Stockfish installed at ${targetBinary}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
