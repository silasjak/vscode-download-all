import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const LAST_DESTINATION_KEY = 'downloadAll.lastDestination';

type ConflictAction = 'overwrite' | 'skip' | 'rename';
type ConflictSetting = ConflictAction | 'prompt';

interface ConflictChoice {
	action: ConflictAction;
	all: boolean;
}

interface PlannedItem {
	source: vscode.Uri;
	target: vscode.Uri;
	label: string;
	overwrite: boolean;
}

let log: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext): void {
	log = vscode.window.createOutputChannel('Download All', { log: true });
	context.subscriptions.push(
		log,
		vscode.commands.registerCommand('downloadAll.download', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
			downloadAll(context, uri, uris)
		)
	);
}

export function deactivate(): void {
	// nothing to clean up beyond the disposables registered above
}

async function downloadAll(context: vscode.ExtensionContext, uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
	// Explorer context menu commands are invoked with (clicked item, full selection).
	const sources = topLevelSelection(uris?.length ? uris : uri ? [uri] : []);
	if (sources.length === 0) {
		vscode.window.showInformationMessage('Download All: select the files or folders you want to download first.');
		return;
	}

	const destination = await pickDestination(context, sources.length);
	if (!destination) {
		return;
	}
	await context.globalState.update(LAST_DESTINATION_KEY, destination.fsPath);

	const plan = await planTransfer(sources, destination);
	if (!plan) {
		return; // user cancelled a conflict prompt
	}
	if (plan.length === 0) {
		vscode.window.showInformationMessage('Download All: every selected item was skipped.');
		return;
	}

	await transfer(plan, destination, context);
}

/**
 * Drops duplicates and items that live inside another selected folder, so a
 * selection of a folder plus its children does not copy anything twice.
 */
function topLevelSelection(uris: vscode.Uri[]): vscode.Uri[] {
	const unique = new Map<string, vscode.Uri>();
	for (const uri of uris) {
		unique.set(uri.toString(), uri);
	}
	const all = [...unique.values()];
	return all.filter(
		candidate =>
			!all.some(
				other =>
					other !== candidate &&
					other.scheme === candidate.scheme &&
					other.authority === candidate.authority &&
					candidate.path.startsWith(other.path.replace(/\/*$/, '') + '/')
			)
	);
}

async function pickDestination(context: vscode.ExtensionContext, count: number): Promise<vscode.Uri | undefined> {
	const defaultUri = await defaultDestination(context);
	if (!defaultUri && vscode.env.remoteName) {
		// Without a local file: URI the dialog would browse the remote file system.
		vscode.window.showWarningMessage(
			'Download All: no local folder known for the dialog. Set "downloadAll.defaultDestination" to a local path.'
		);
	}

	const picked = await vscode.window.showOpenDialog({
		title: 'Choose Where to Download',
		openLabel: count === 1 ? 'Download item' : `Download ${count} items`,
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		defaultUri
	});
	return picked?.[0];
}

async function defaultDestination(context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
	const candidates: string[] = [];

	const lastUsed = context.globalState.get<string>(LAST_DESTINATION_KEY);
	if (lastUsed) {
		candidates.push(lastUsed);
	}

	const configured = config().get<string>('defaultDestination', '').trim();
	if (configured) {
		candidates.push(expandHome(configured, context));
	}

	if (runsLocally(context)) {
		candidates.push(path.join(os.homedir(), 'Downloads'), os.homedir());
	}

	for (const candidate of candidates) {
		const uri = vscode.Uri.file(candidate);
		if (await exists(uri)) {
			return uri;
		}
	}
	return undefined;
}

async function planTransfer(sources: vscode.Uri[], destination: vscode.Uri): Promise<PlannedItem[] | undefined> {
	const setting = config().get<ConflictSetting>('onConflict', 'prompt');
	let applyToAll: ConflictAction | undefined = setting === 'prompt' ? undefined : setting;

	const planned: PlannedItem[] = [];
	const claimed = new Set<string>();

	for (const source of sources) {
		const name = path.posix.basename(source.path);
		const target = vscode.Uri.joinPath(destination, name);

		// A name can be taken by the destination folder or by an earlier item of
		// this same batch (two files of the same name from different folders).
		const taken = claimed.has(key(target)) || (await exists(target));
		if (!taken) {
			claimed.add(key(target));
			planned.push({ source, target, label: name, overwrite: false });
			continue;
		}

		const choice = applyToAll ? { action: applyToAll, all: true } : await askAboutConflict(name);
		if (!choice) {
			return undefined;
		}
		if (choice.all) {
			applyToAll = choice.action;
		}
		if (choice.action === 'skip') {
			log.info(`Skipped ${source.toString(true)} - "${name}" already exists in the destination`);
			continue;
		}

		const finalTarget = choice.action === 'rename' ? await uniqueTarget(destination, name, claimed) : target;
		claimed.add(key(finalTarget));
		planned.push({
			source,
			target: finalTarget,
			label: path.posix.basename(finalTarget.path),
			overwrite: choice.action === 'overwrite'
		});
	}

	return planned;
}

async function askAboutConflict(name: string): Promise<ConflictChoice | undefined> {
	const items: (vscode.QuickPickItem & { choice: ConflictChoice })[] = [
		{ label: 'Overwrite', description: 'Replace this item', choice: { action: 'overwrite', all: false } },
		{ label: 'Overwrite All', description: 'Replace every remaining conflict', choice: { action: 'overwrite', all: true } },
		{ label: 'Keep Both', description: 'Download with a counter appended', choice: { action: 'rename', all: false } },
		{ label: 'Keep Both for All', description: 'Append a counter for every remaining conflict', choice: { action: 'rename', all: true } },
		{ label: 'Skip', description: 'Do not download this item', choice: { action: 'skip', all: false } },
		{ label: 'Skip All', description: 'Do not download any conflicting item', choice: { action: 'skip', all: true } }
	];

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Download All',
		placeHolder: `"${name}" already exists in the destination`,
		ignoreFocusOut: true
	});
	return picked?.choice;
}

async function uniqueTarget(destination: vscode.Uri, name: string, claimed: Set<string>): Promise<vscode.Uri> {
	const extension = path.extname(name);
	const stem = extension ? name.slice(0, -extension.length) : name;

	for (let counter = 2; ; counter++) {
		const candidate = vscode.Uri.joinPath(destination, `${stem} (${counter})${extension}`);
		if (!claimed.has(key(candidate)) && !(await exists(candidate))) {
			return candidate;
		}
	}
}

async function transfer(plan: PlannedItem[], destination: vscode.Uri, context: vscode.ExtensionContext): Promise<void> {
	const concurrency = Math.min(config().get<number>('concurrency', 4), plan.length);
	const queue = [...plan];
	let started = 0;
	let succeeded = 0;
	let failed = 0;

	const cancelled = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Downloading ${plan.length} item${plan.length === 1 ? '' : 's'}`,
			cancellable: true
		},
		async (progress, token) => {
			const worker = async (): Promise<void> => {
				while (queue.length > 0 && !token.isCancellationRequested) {
					const item = queue.shift()!;
					progress.report({ message: `${++started}/${plan.length} · ${item.label}` });
					try {
						await vscode.workspace.fs.copy(item.source, item.target, { overwrite: item.overwrite });
						succeeded++;
					} catch (error) {
						failed++;
						log.error(`Failed to download ${item.source.toString(true)}: ${messageOf(error)}`);
					}
					progress.report({ increment: 100 / plan.length });
				}
			};

			await Promise.all(Array.from({ length: Math.max(concurrency, 1) }, worker));
			return token.isCancellationRequested;
		}
	);

	if (failed > 0) {
		const action = await vscode.window.showWarningMessage(
			`Downloaded ${succeeded} of ${plan.length} items, ${failed} failed.`,
			'Show Log'
		);
		if (action) {
			log.show();
		}
		return;
	}

	if (cancelled) {
		vscode.window.showInformationMessage(`Download cancelled after ${succeeded} of ${plan.length} items.`);
		return;
	}

	const action = await vscode.window.showInformationMessage(
		`Downloaded ${succeeded} item${succeeded === 1 ? '' : 's'} to ${tildify(destination.fsPath, context)}`,
		'Open Folder'
	);
	if (action) {
		vscode.env.openExternal(destination);
	}
}

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('downloadAll');
}

/** True when this extension host sits on the same machine as the user's desktop. */
function runsLocally(context: vscode.ExtensionContext): boolean {
	return !vscode.env.remoteName || context.extension.extensionKind === vscode.ExtensionKind.UI;
}

function expandHome(target: string, context: vscode.ExtensionContext): string {
	if (runsLocally(context) && (target === '~' || target.startsWith('~/'))) {
		return path.join(os.homedir(), target.slice(1));
	}
	return target;
}

function tildify(fsPath: string, context: vscode.ExtensionContext): string {
	if (!runsLocally(context)) {
		return fsPath;
	}
	const home = os.homedir();
	return fsPath === home || fsPath.startsWith(home + path.sep) ? '~' + fsPath.slice(home.length) : fsPath;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function key(uri: vscode.Uri): string {
	return process.platform === 'linux' ? uri.fsPath : uri.fsPath.toLowerCase();
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
