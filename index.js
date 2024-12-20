#!/usr/bin/env node

import { program } from "commander";
import chokidar from "chokidar";
import sqlite3 from "sqlite3";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import debounce from "lodash-es/debounce.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
import zlib from "zlib";
import { Buffer } from "buffer";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE = path.join(process.env.HOME, ".ngit.json");
const NOTES_DB_PATH = path.join(
  process.env.HOME,
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

let isRunning = false;
let watcher;

const gunzip = promisify(zlib.gunzip);

async function setupConfig(repoPath) {
  const config = {
    repoPath: path.resolve(repoPath),
    lastSync: null,
  };

  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log("Configuration saved. Now run `ngit start` to begin syncing.");
}

async function getConfig() {
  try {
    const config = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
    return config;
  } catch (err) {
    console.error("Please run `ngit setup <repo-path>` first");
    process.exit(1);
  }
}

async function exportNotes(fromCLI = false, outputDir = null) {
  const config = await getConfig();
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    const tmpDbPath = path.join(
      outputDir ? path.resolve(outputDir) : os.tmpdir(),
      `notes-db-${Date.now()}.sqlite`
    );

    try {
      // Copy database to temp location
      await fs.copyFile(NOTES_DB_PATH, tmpDbPath);

      // Add a small delay to ensure the file is fully written and released
      const fileHandle = await fs.open(tmpDbPath, "r");
      await fileHandle.sync();
      await fileHandle.close();

      // Verify the copy was successful
      const sourceStats = await fs.stat(NOTES_DB_PATH);
      const destStats = await fs.stat(tmpDbPath);

      if (destStats.size !== sourceStats.size) {
        throw new Error(
          "Database copy verification failed: file sizes do not match"
        );
      }

      // Open database with read-only mode and timeout
      const db = new sqlite3.Database(
        tmpDbPath,
        sqlite3.OPEN_READONLY,
        (err) => {
          if (err) throw new Error(`Failed to open database: ${err.message}`);
        }
      );

      const exportDir = outputDir
        ? path.resolve(outputDir)
        : path.join(os.tmpdir(), `notes-export-${Date.now()}`);

      if (fromCLI) {
        console.log(`Exporting to directory: ${exportDir}`);
      }
      await fs.mkdir(exportDir, { recursive: true });

      const query = `
      SELECT 
        Z.Z_PK as key,
        _FOLDER.ZTITLE2 as folder,
        NOTEDATA.ZDATA as data,
        Z.ZCREATIONDATE1 as date,
        Z.ZTITLE1 as title
      FROM ZICCLOUDSYNCINGOBJECT as Z
      INNER JOIN ZICCLOUDSYNCINGOBJECT AS _FOLDER 
        ON Z.ZFOLDER = _FOLDER.Z_PK
      INNER JOIN ZICNOTEDATA as NOTEDATA 
        ON Z.ZNOTEDATA = NOTEDATA.Z_PK
    `;

      return new Promise((resolve, reject) => {
        db.all(query, async (err, rows) => {
          if (err) reject(err);

          try {
            for (const note of rows) {
              try {
                const folderPath = path.join(exportDir, note.folder);
                await fs.mkdir(folderPath, { recursive: true });

                const fileName = `${note.key} - ${note.title.replace(
                  /[^a-z0-9]/gi,
                  "_"
                )}.md`;
                const filePath = path.join(folderPath, fileName);

                const timestamp = (note.date + 978307200) * 1000;
                const buffer = Buffer.from(note.data);
                const decompressed = await gunzip(buffer);
                const content = convertToMarkdown(
                  decompressed.toString("utf-8")
                );

                await fs.writeFile(filePath, content);
                await fs.utimes(filePath, timestamp, timestamp);
              } catch (error) {
                if (error.code === "Z_DATA_ERROR") {
                  console.log(`Skipping encrypted/locked note: ${note.key}`);
                  continue;
                }
                console.error(`Error processing note ${note.title}:`, error);
              }
            }

            if (!fromCLI) {
              // Only move files to repo if not called from CLI
              await fs.rm(config.repoPath, { recursive: true, force: true });
              await fs.cp(exportDir, config.repoPath, { recursive: true });
              await fs.rm(exportDir, { recursive: true });
            } else if (!outputDir) {
              // If CLI but no output dir specified, keep files in temp dir
              console.log(`Notes exported to: ${exportDir}`);
            }

            db.close();

            // Clean up SQLite files
            const baseFileName = path.parse(tmpDbPath).name;
            const dbDir = path.dirname(tmpDbPath);
            const filesToDelete = [
              tmpDbPath,
              path.join(dbDir, `${baseFileName}.sqlite-shm`),
              path.join(dbDir, `${baseFileName}.sqlite-wal`),
            ];

            for (const file of filesToDelete) {
              try {
                await fs.unlink(file);
              } catch (err) {
                // Ignore errors if files don't exist
                if (err.code !== "ENOENT") {
                  console.warn(`Could not delete file ${file}:`, err);
                }
              }
            }

            resolve();
          } catch (error) {
            console.error("Error processing notes:", error);
            db.close();
            reject(error);
          }
        });
      });
    } catch (error) {
      attempt++;
      console.error(`Attempt ${attempt}/${maxRetries} failed:`, error.message);

      // Clean up the temporary database file
      try {
        await fs.unlink(tmpDbPath);
      } catch (cleanupErr) {
        console.warn("Could not clean up temporary database file:", cleanupErr);
      }

      if (attempt === maxRetries) {
        throw new Error(
          `Failed to export notes after ${maxRetries} attempts: ${error.message}`
        );
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    break; // If we get here, the export was successful
  }
}

function convertToMarkdown(input) {
  const startIndex = input.indexOf("\u0008\u0000\u0010\u0000\u001a");
  if (startIndex === -1) {
    // If no binary marker found, treat as plain text/markdown
    return input.trim();
  }

  // Find the actual content start after the binary marker
  const contentStart = input.indexOf("\u0012", startIndex + 1);
  if (contentStart === -1) return input.trim();

  // Find the content end marker
  const contentEnd = input.indexOf(
    "\u0004\u0008\u0000\u0010\u0000\u0010\u0000\u001a\u0004\u0008\u0000",
    contentStart + 2
  );

  // Extract the content
  const content =
    contentEnd === -1
      ? input.substring(contentStart + 2)
      : input.substring(contentStart + 2, contentEnd);

  // Convert rich text formatting to Markdown
  return (
    content
      // Remove control characters except newlines
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "")
      // Convert rich text formatting
      .replace(/\{\\b ([^}]+)\}/g, "**$1**") // Bold
      .replace(/\{\\i ([^}]+)\}/g, "_$1_") // Italic
      .replace(/\{\\strike ([^}]+)\}/g, "~~$1~~") // Strikethrough
      // Convert lists
      .replace(/^\s*•\s+/gm, "- ") // Bullet points
      .replace(/^\s*(\d+)\.\s+/gm, "$1. ") // Numbered lists
      // Convert headings (assuming they're larger text)
      .replace(/\{\\fs\d+ ([^}]+)\}/g, (match, p1) => {
        // Extract font size and convert to appropriate heading level
        const size = parseInt(match.match(/\\fs(\d+)/)[1]);
        const level = Math.max(1, Math.min(6, Math.floor((48 - size) / 4)));
        return "#".repeat(level) + " " + p1;
      })
      // Convert links
      .replace(
        /\{\\field{\\*\\fldinst HYPERLINK "([^"]+)"}{\\fldrslt ([^}]+)}\}/g,
        "[$2]($1)"
      )
      // Clean up any remaining RTF-style formatting
      .replace(/\{[^}]+\}/g, "")
      // Remove zero-width spaces and trim
      .replace(/\u200B/g, "")
      .trim()
  );
}

const syncToGit = debounce(async () => {
  const config = await getConfig();

  try {
    await exportNotes();

    const execAsync = promisify(exec);
    const gitCommands = [
      `cd ${config.repoPath}`,
      "git add .",
      'git commit -m "Auto-sync notes"',
      "git push",
    ];

    await execAsync(gitCommands.join(" && "));
    console.log("Notes synced to Git successfully");

    config.lastSync = new Date().toISOString();
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error("Error syncing to Git:", err);
  }
}, 5000);

async function startWatcher() {
  if (isRunning) {
    console.log("Sync is already running");
    return;
  }

  await getConfig(); // Verify config exists

  watcher = chokidar.watch(NOTES_DB_PATH, {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on("change", () => {
    console.log("Notes changed, syncing...");
    syncToGit();
  });

  isRunning = true;
  console.log("Watching for Notes changes...");
}

function stopWatcher() {
  if (!isRunning) {
    console.log("Sync is not running");
    return;
  }

  watcher.close();
  isRunning = false;
  console.log("Stopped watching for changes");
}

// CLI setup
program
  .name("ngit")
  .description("Sync Apple Notes to Git automatically")
  .version("1.0.0");

program
  .command("setup")
  .argument("<repo-path>", "Path to Git repository")
  .description("Configure the Git repository for syncing")
  .action(setupConfig);

program
  .command("start")
  .description("Start watching Notes for changes")
  .action(startWatcher);

program
  .command("stop")
  .description("Stop watching Notes for changes")
  .action(stopWatcher);

program
  .command("export")
  .description("Export notes to directory")
  .option("-d, --dir <path>", "Output directory (optional)")
  .action(async (options) => {
    try {
      await exportNotes(true, options.dir);
    } catch (err) {
      console.error("Export failed:", err);
      process.exit(1);
    }
  });

program.parse();
