// The module 'vscode' contains the VS Code extensibility API
// Import the necessary extensibility types to use in your code below
import { Disposable, ExtensionContext, commands, window, workspace, Uri, Extension, extensions, env } from 'vscode';
import { AWClient, IAppEditorEvent } from '../aw-client-js/src/aw-client';
import { hostname } from 'os';
import { API, GitExtension } from './git';
import { DEFAULT_MAX_HEARTBEATS_PER_SEC, parseMaxHeartbeatsPerSec, shouldSendHeartbeat } from './throttle';

// This method is called when your extension is activated. Activation is
// controlled by the activation events defined in package.json.
export function activate(context: ExtensionContext) {
    // Log to a dedicated Output channel instead of the console, so the
    // extension does not spam the Extension Host debug console (#30).
    const output = window.createOutputChannel('ActivityWatch');
    context.subscriptions.push(output);
    const log = (message: string) => output.appendLine(`[${new Date().toISOString()}] ${message}`);
    log('Extension activated');

    // Init ActivityWatch
    const controller = new ActivityWatch(log);
    controller.init();
    context.subscriptions.push(controller);

    // Command:Reload
    const reloadCommand = commands.registerCommand('extension.reload', () => controller.init());
    context.subscriptions.push(reloadCommand);
}

// Each VS Code-compatible editor gets a distinct client/bucket name so
// activity streams don't overlap when several are installed (PR #50).
// Default VS Code behavior is preserved via the fallback.
function activityWatchClientName(): string {
    const appName = env.appName.toLowerCase();

    if (appName.includes('cursor')) {
        return 'aw-watcher-cursor';
    }
    if (appName.includes('antigravity')) {
        return 'aw-watcher-antigravity';
    }
    if (appName.includes('codium')) {
        return 'aw-watcher-vscodium';
    }

    return 'aw-watcher-vscode';
}

class ActivityWatch {
    private _disposable: Disposable;
    private _client!: AWClient;
    private _git: API | undefined;

    // Bucket info
    private _bucket: {
        id: string;
        hostName: string;
        clientName: string;
        eventType: string;
    };
    private _bucketCreated: boolean = false;

    // Heartbeat handling
    private _pulseTime: number = 20;
    private _maxHeartbeatsPerSec: number = DEFAULT_MAX_HEARTBEATS_PER_SEC;
    private _lastFilePath: string = '';
    private _lastHeartbeatTime: number = 0; // Date.getTime()
    private _lastBranch: string = '';

    // Server configuration (loaded in init via loadConfigurations)
    private _enabled: boolean = true;
    private _serverUrl: string = '';
    private _authUser: string = '';
    private _authPassword: string = '';

    constructor(private readonly _log: (message: string) => void) {
        this._bucket = {
            id: '',
            hostName: hostname(),
            clientName: activityWatchClientName(),
            eventType: 'app.editor.activity'
        };
        this._bucket.id = `${this._bucket.clientName}_${this._bucket.hostName}`;

        // NOTE: AWClient is (re)created in init() so the Reload command
        // picks up serverUrl/auth changes.

        // subscribe to VS Code Events
        const subscriptions: Disposable[] = [];
        window.onDidChangeTextEditorSelection(this._onEvent, this, subscriptions);
        window.onDidChangeActiveTextEditor(this._onEvent, this, subscriptions);
        this._disposable = Disposable.from(...subscriptions);
    }

    public init() {
        this.loadConfigurations();

        if (!this._enabled) {
            this._log('Extension disabled via aw-watcher-vscode.enabled setting');
            this._bucketCreated = false;
            return;
        }

        // (Re)create client so serverUrl/auth changes apply on Reload
        const clientOptions: { testing: boolean; baseURL?: string } = { testing: false };
        const baseURL = this._buildBaseUrl();
        if (baseURL) {
            clientOptions.baseURL = baseURL;
        }
        this._client = new AWClient(this._bucket.clientName, clientOptions);

        // Create new Bucket (if not existing)
        this._client.ensureBucket(this._bucket.id, this._bucket.eventType, this._bucket.hostName)
            .then((res) => {
                if (res.alreadyExist) {
                    this._log(`Bucket ${this._bucket.id} already exists`);
                } else {
                    this._log(`Created bucket ${this._bucket.id}`);
                }
                this._bucketCreated = true;
            })
            .catch(err => {
                this._handleError("Couldn't create Bucket. Please make sure the server is running properly and then run the [Reload ActivityWatch] command.", true);
                this._bucketCreated = false;
                this._log(`Error creating bucket: ${err instanceof Error ? err.message : String(err)}`);
            });
        this.initGit().then((res) => this._git = res);
    }

    private async initGit() {
        const extension = extensions.getExtension('vscode.git') as Extension<GitExtension>;
        const gitExtension = extension.isActive ? extension.exports : await extension.activate();
        return gitExtension.getAPI(1);
    }

    public loadConfigurations() {
        const extConfigurations = workspace.getConfiguration('aw-watcher-vscode');
        this._maxHeartbeatsPerSec = parseMaxHeartbeatsPerSec(extConfigurations.get('maxHeartbeatsPerSec'));
        const enabled = extConfigurations.get('enabled');
        if (typeof enabled === 'boolean') {
            this._enabled = enabled;
        }
        const serverUrl = extConfigurations.get('serverUrl');
        if (typeof serverUrl === 'string') {
            this._serverUrl = serverUrl.trim().replace(/\/+$/, '');
        }
        const authUser = extConfigurations.get('authUser');
        if (typeof authUser === 'string') {
            this._authUser = authUser;
        }
        const authPassword = extConfigurations.get('authPassword');
        if (typeof authPassword === 'string') {
            this._authPassword = authPassword;
        }
    }

    // Resolve the AW server base URL. Custom host/port setups (PR #51) are
    // covered by the serverUrl setting (fixes #27). When Basic Auth
    // credentials are configured (nginx auth_basic), they are embedded in
    // the URL since the fetch-based aw-client-js has no axios instance to
    // inject headers into.
    private _buildBaseUrl(): string | undefined {
        let url = this._serverUrl || 'http://127.0.0.1:5600';
        if (this._authUser && this._authPassword) {
            try {
                const parsed = new URL(url);
                parsed.username = encodeURIComponent(this._authUser);
                parsed.password = encodeURIComponent(this._authPassword);
                url = parsed.toString().replace(/\/+$/, '');
            } catch {
                this._log(`Ignoring invalid serverUrl: ${url}`);
            }
        }
        return url;
    }

    public dispose() {
        this._disposable.dispose();
    }

    private _onEvent() {
        if (!this._enabled || !this._bucketCreated) {
            return;
        }

        // Create and send heartbeat
        try {
            const heartbeat = this._createHeartbeat();
            const current = {
                file: heartbeat.data.file,
                branch: String(heartbeat.data.branch),
                time: heartbeat.timestamp.getTime()
            };
            const last = { file: this._lastFilePath, branch: this._lastBranch, time: this._lastHeartbeatTime };

            // Send heartbeat if file changed, branch changed or enough time passed
            if (shouldSendHeartbeat(last, current, this._maxHeartbeatsPerSec)) {
                this._lastFilePath = current.file;
                this._lastBranch = current.branch;
                this._lastHeartbeatTime = current.time;
                this._sendHeartbeat(heartbeat);
            }
        }
        catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._handleError(message);
        }
    }

    private _sendHeartbeat(event: IAppEditorEvent) {
        return this._client.heartbeat(this._bucket.id, this._pulseTime, event)
            .catch((err: unknown) => {
                // Log-only: heartbeat failures are transient (server restart,
                // network blip) and a modal on every failure spams the user
                // (#12, #13). Bucket-creation failure still raises a toast.
                // Note: the fetch-based client rejects with FetchError, not
                // `{ err }`, so extract the message properly.
                const message = err instanceof Error ? err.message : String(err);
                this._log(`Error sending heartbeat: ${message}`);
            });
    }

    private _createHeartbeat(): IAppEditorEvent {
        return {
            timestamp: new Date(),
            duration: 0,
            data: {
                editor: env.appName || 'VS Code',
                language: this._getFileLanguage() || 'unknown',
                project: this._getProjectFolder() || 'unknown',
                file: this._getFilePath() || 'unknown',
                branch: this._getCurrentBranch() || 'unknown'
            }
        };
    }

    private _getProjectFolder(): string | undefined {
        const fileUri = this._getActiveFileUri();
        if (!fileUri) {
            return;
        }
        const workspaceFolder = workspace.getWorkspaceFolder(fileUri);
        if (!workspaceFolder) {
            return;
        }

        return workspaceFolder.uri.path;
    }

    private _getActiveFileUri(): Uri | undefined {
        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }

        return editor.document.uri;
    }

    private _getFilePath(): string | undefined {
        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }

        return editor.document.fileName;
    }

    private _getFileLanguage(): string | undefined {
        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }

        return editor.document.languageId;
    }

    private _getCurrentBranch(): string | undefined {
        if (this._git === undefined) {
            return;
        }
        return this._git.repositories[0]?.state?.HEAD?.name;
    }

    private _handleError(err: string, isCritical = false): undefined {
        if (isCritical) {
            this._log(`Error: ${err}`);
            window.showErrorMessage(`[ActivityWatch] ${err}`);
        }
        else {
            this._log(`Warning: ${err}`);
        }
        return;
    }
}
