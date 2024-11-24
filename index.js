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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE = path.join(process.env.HOME, ".ngit.json");
const NOTES_DB_PATH = path.join(
	process.env.HOME,
	"Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

let isRunning = false;
let watcher;

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

async function exportNotes() {
	const config = await getConfig();
	const db = new sqlite3.Database(NOTES_DB_PATH);

	// Note: This is a simplified query. You'd need to handle attachments and formatting
	const query = `
    SELECT 
      z_pk,
      ztitle,
      zbody,
      zmodificationdate
    FROM ziccloudsyncingobject 
    WHERE ztitle IS NOT NULL
  `;

	return new Promise((resolve, reject) => {
		db.all(query, async (err, rows) => {
			if (err) reject(err);

			for (const note of rows) {
				const fileName = `${note.ztitle.replace(/[^a-z0-9]/gi, "_")}.md`;
				const filePath = path.join(config.repoPath, fileName);
				await fs.writeFile(filePath, note.zbody);
			}

			db.close();
			resolve();
		});
	});
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
	.action(exportNotes);

program.parse();
