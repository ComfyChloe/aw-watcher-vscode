// The module 'vscode' contains the VS Code extensibility API
// Import the necessary extensibility types to use in your code below
import { Disposable, ExtensionContext, commands, window, workspace, Uri, Extension, extensions } from 'vscode';
import { AWClient, IAppEditorEvent } from '../aw-client-js/src/aw-client';
import { hostname } from 'os';
import { API, GitExtension } from './git';

// This method is called when your extension is activated. Activation is
// controlled by the activation events defined in package.json.
export function activate(context: ExtensionContext) {
    console.log('Congratulations, your extension "ActivityWatch" is now active!');

    // Init ActivityWatch
    const controller = new ActivityWatch();
    controller.init();
    context.subscriptions.push(controller);

    // Command:Reload
    const reloadCommand = commands.registerCommand('extension.reload', () => controller.init());
    context.subscriptions.push(reloadCommand);
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
    private _maxHeartbeatsPerSec: number = 1;
    private _lastFilePath: string = '';
    private _lastHeartbeatTime: number = 0; // Date.getTime()
    private _lastBranch: string = '';

    // Server configuration (loaded in init via loadConfigurations)
    private _enabled: boolean = true;
    private _serverUrl: string = '';
    private _authUser: string = '';
    private _authPassword: string = '';

    constructor() {
        this._bucket = {
            id: '',
            hostName: hostname(),
            clientName: 'aw-watcher-vscode',
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
            console.log('[ActivityWatch] Extension disabled via aw-watcher-vscode.enabled setting');
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
                    console.log('Bucket already exists');
                } else {
                    console.log('Created Bucket');
                }
                this._bucketCreated = true;
            })
            .catch(err => {
                this._handleError("Couldn't create Bucket. Please make sure the server is running properly and then run the [Reload ActivityWatch] command.", true);
                this._bucketCreated = false;
                console.error(err);
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
        const maxHeartbeatsPerSec = extConfigurations.get('maxHeartbeatsPerSec');
        if (maxHeartbeatsPerSec) {
            this._maxHeartbeatsPerSec = maxHeartbeatsPerSec as number;
        }
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
            } catch (err) {
                console.warn('[ActivityWatch] Ignoring invalid serverUrl:', url, err);
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
            const filePath = this._getFilePath();
            const curTime = new Date().getTime();
            const branch = this._getCurrentBranch();

            // Send heartbeat if file changed, branch changed or enough time passed
            if (filePath !== this._lastFilePath ||
                    branch !== this._lastBranch ||
                    this._lastHeartbeatTime + (1000 / (this._maxHeartbeatsPerSec)) < curTime) {
                this._lastFilePath = filePath || 'unknown';
                this._lastHeartbeatTime = curTime;
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
            .then(() => console.log('Sent heartbeat', event))
            .catch(({ err }) => {
                console.error('sendHeartbeat error: ', err);
                this._handleError('Error while sending heartbeat', true);
            });
    }

    private _createHeartbeat(): IAppEditorEvent {
        return {
            timestamp: new Date(),
            duration: 0,
            data: {
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
            console.error('[ActivityWatch][handleError]', err);
            window.showErrorMessage(`[ActivityWatch] ${err}`);
        }
        else {
            console.warn('[AcitivtyWatch][handleError]', err);
        }
        return;
    }
}
