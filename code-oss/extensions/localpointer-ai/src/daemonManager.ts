/*---------------------------------------------------------------------------------------------
 *  LocalPointer AI — local Ollama integration for Code-OSS
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { DaemonClient } from './daemon';
import { getConfig } from './config';

export class DaemonManager implements vscode.Disposable {
	private process: ChildProcess | undefined;
	private client: DaemonClient;
	private readonly output: vscode.OutputChannel;
	private startPromise: Promise<void> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.output = vscode.window.createOutputChannel('LocalPointer Daemon');
		this.client = new DaemonClient(getConfig().daemonUrl);
		context.subscriptions.push(this.output);
	}

	getClient(): DaemonClient {
		this.client = new DaemonClient(getConfig().daemonUrl);
		return this.client;
	}

	async ensureRunning(): Promise<DaemonClient> {
		if (!this.startPromise) {
			this.startPromise = this.startIfNeeded();
		}
		await this.startPromise;
		return this.getClient();
	}

	private async startIfNeeded(): Promise<void> {
		const client = this.getClient();
		const health = await client.health();
		if (health.ok) {
			this.output.appendLine('Daemon already running.');
			return;
		}

		const binary = this.resolveBinaryPath();
		if (!binary) {
			this.output.appendLine('Daemon binary not found; extension will use Ollama directly.');
			return;
		}

		const cfg = getConfig();
		const env = {
			...process.env,
			PORT: new URL(cfg.daemonUrl).port || '9477',
			HOST: '127.0.0.1',
			OLLAMA_BASE_URL: cfg.ollamaUrl,
		};

		this.output.appendLine(`Starting daemon: ${binary}`);
		const child = spawn(binary, [], {
			env,
			cwd: path.dirname(binary),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.process = child;

		child.stdout?.on('data', (chunk: Buffer) => {
			this.output.append(chunk.toString());
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			this.output.append(chunk.toString());
		});
		child.on('exit', (code, signal) => {
			this.output.appendLine(`Daemon exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
			this.process = undefined;
			this.startPromise = undefined;
		});

		for (let i = 0; i < 30; i++) {
			await delay(200);
			const h = await client.health();
			if (h.ok) {
				this.output.appendLine('Daemon is healthy.');
				return;
			}
		}
		this.output.appendLine('Daemon did not become healthy in time.');
	}

	private resolveBinaryPath(): string | undefined {
		const cfg = getConfig();
		const candidates: string[] = [];
		if (cfg.daemonPath.trim()) {
			candidates.push(cfg.daemonPath.trim());
		}
		candidates.push(
			path.join(this.context.extensionPath, 'bin/localpointer-daemon'),
			path.join(this.context.extensionPath, '../../../../daemon/localpointer-daemon'),
			path.join(this.context.extensionPath, '../../../daemon/localpointer-daemon'),
			path.join(this.context.extensionPath, '../../../daemon/localpointer-daemon.exe'),
		);

		for (const candidate of candidates) {
			try {
				if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
					return candidate;
				}
			} catch {
				// continue
			}
		}
		return undefined;
	}

	dispose(): void {
		if (this.process && !this.process.killed) {
			this.process.kill();
		}
		this.process = undefined;
		this.startPromise = undefined;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
