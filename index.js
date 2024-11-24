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
// const NOTES_DB_PATH = path.join(
// 	process.env.HOME,
// 	"Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
// );
const NOTES_DB_PATH = path.join(__dirname, "NoteStore.sqlite");

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

async function exportNotes(fromCLI = false) {
	const config = await getConfig();
	const db = new sqlite3.Database(NOTES_DB_PATH);

	const tmpDir = path.join(os.tmpdir(), `notes-export-${Date.now()}`);
	if (fromCLI) {
		console.log(`Exporting to temporary directory: ${tmpDir}`);
	}
	await fs.mkdir(tmpDir, { recursive: true });

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
						const folderPath = path.join(tmpDir, note.folder);
						await fs.mkdir(folderPath, { recursive: true });

						const fileName = `${note.key} - ${note.title.replace(
							/[^a-z0-9]/gi,
							"_"
						)}.md`;
						const filePath = path.join(folderPath, fileName);

						const timestamp = (note.date + 978307200) * 1000;
						const buffer = Buffer.from(note.data);
						const decompressed = await gunzip(buffer);
						const content = getPlainText(decompressed.toString("utf-8"));

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
					await fs.cp(tmpDir, config.repoPath, { recursive: true });
				}

				if (!fromCLI) {
					// Only cleanup temp directory if not called from CLI
					await fs.rm(tmpDir, { recursive: true });
				}

				db.close();
				resolve();
			} catch (error) {
				console.error("Error processing notes:", error);
				db.close();
				reject(error);
			}
		});
	});
}

function getPlainText(input) {
	const startIndex = input.indexOf("\u0008\u0000\u0010\u0000\u001a");
	if (startIndex === -1) return input;

	const contentStart = input.indexOf("\u0012", startIndex + 1);
	if (contentStart === -1) return input;

	const contentEnd = input.indexOf(
		"\u0004\u0008\u0000\u0010\u0000\u0010\u0000\u001a\u0004\u0008\u0000",
		contentStart + 2
	);
	if (contentEnd === -1) return input.substring(contentStart + 2);

	return input.substring(contentStart + 2, contentEnd);
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
	.description("Export notes to Git")
	.action(() => exportNotes(true));

program.parse();
