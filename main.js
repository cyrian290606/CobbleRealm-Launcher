const {
    app,
    BrowserWindow,
    Menu,
    ipcMain,
    shell,
    clipboard
} = require("electron");

const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");

const {
    Client
} = require("minecraft-launcher-core");

const {
    loginMicrosoft,
    getMicrosoftSession,
    logoutMicrosoft
} = require("./auth");

const {
    loginMinecraft
} = require("./minecraftAuth");

const { createUpdater } = require("./updater");
const { ensureJava } = require("./runtime");
const { ensureFabricProfile } = require("./fabric");
const { initLauncherUpdates } = require("./launcherUpdates");
const { describeError } = require("./playerErrors");
const { sanitize, buildReport, currentUserNames } = require("./support");


/* ==============================
   CONFIGURATION
============================== */

Menu.setApplicationMenu(null);

const launcher = new Client();

let launchInProgress = false;

/* ==============================
   INSTANCE UNIQUE
============================== */

const hasSingleInstanceLock =
    app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {

    app.quit();

} else {

    app.on("second-instance", () => {

        const win =
            BrowserWindow.getAllWindows()[0];

        if (win && !win.isDestroyed()) {

            if (win.isMinimized()) {
                win.restore();
            }

            win.show();
            win.focus();
        }
    });
}


/* ==============================
   UTILITAIRES
============================== */

/*
 * Masque les secrets (jeton d'accès) dans un texte avant
 * de l'afficher en console ou de l'envoyer à l'interface.
 * MCLC écrit toute la ligne de commande Java dans ses
 * messages "debug", y compris --accessToken.
 */
function redactSecrets(text) {

    return String(text)
        .replace(
            /(--accessToken\s+)\S+/gi,
            "$1***"
        )
        .replace(
            /(--(?:session|xuid|clientId)\s+)\S+/gi,
            "$1***"
        )
        .replace(
            /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
            "***"
        );
}


/* Envoi sans erreur si la fenêtre a été fermée entre-temps. */
function safeSend(sender, channel, payload) {

    try {

        if (sender && !sender.isDestroyed()) {
            sender.send(channel, payload);
        }

    } catch (error) {

        console.warn(
            "[CobbleRealm] Envoi IPC impossible :",
            channel
        );
    }
}


/* Seules les pages de connexion Microsoft peuvent être ouvertes automatiquement. */
function isMicrosoftUrl(value) {

    try {

        const url = new URL(value);

        return (
            url.protocol === "https:" &&
            /(^|\.)(microsoft\.com|live\.com|microsoftonline\.com)$/.test(url.hostname)
        );

    } catch {

        return false;
    }
}


/* Callback du code d'appareil Microsoft, vers l'interface. */
function createDeviceCodeHandler(sender) {

    return async (deviceCode) => {

        safeSend(
            sender,
            "microsoft-device-code",
            deviceCode
        );

        if (
            deviceCode &&
            typeof deviceCode.verificationUri === "string" &&
            isMicrosoftUrl(deviceCode.verificationUri)
        ) {

            try {
                await shell.openExternal(
                    deviceCode.verificationUri
                );
            } catch {}
        }
    };
}


/* ==============================
   MÉMOIRE RAM
============================== */

const MAX_RAM_GB_HARD_LIMIT = 16;
const MIN_RAM_GB = 2;
const RAM_RESERVED_FOR_SYSTEM_GB = 2;

function getRamLimits() {

    const totalGb =
        os.totalmem() / (1024 ** 3);

    /* On laisse au moins 2 Go à Windows. */
    const maxRam =
        Math.max(
            MIN_RAM_GB,
            Math.min(
                MAX_RAM_GB_HARD_LIMIT,
                Math.floor(totalGb - RAM_RESERVED_FOR_SYSTEM_GB)
            )
        );

    /* 6 Go sur une machine à 16 Go ou plus, sinon 4 Go. */
    const defaultRam =
        Math.min(
            maxRam,
            totalGb >= 16 ? 6 : 4
        );

    return {
        minRam: MIN_RAM_GB,
        maxRam,
        defaultRam
    };
}


function clampRam(value) {

    const {
        minRam,
        maxRam,
        defaultRam
    } = getRamLimits();

    const number =
        Math.round(Number(value));

    if (!Number.isFinite(number) || number <= 0) {
        return defaultRam;
    }

    return Math.max(
        minRam,
        Math.min(number, maxRam)
    );
}


/*
 * Mode développement : uniquement avec `npm start` (application non empaquetée)
 * ET COBBLEREALM_DEV=1. Permet de pointer vers un serveur de test local et un
 * dossier de jeu jetable, sans jamais toucher à l'installation réelle.
 * Ignoré dans l'application installée.
 */
const DEV_MODE =
    !app.isPackaged &&
    process.env.COBBLEREALM_DEV === "1";

const COBBLEREALM_MANIFEST_URL =
    (DEV_MODE && process.env.COBBLEREALM_MANIFEST_URL) ||
    "https://cyrian290606.github.io/CobbleRealm-Launcher/manifest.json";

const COBBLEREALM_NEWS_URL =
    "https://raw.githubusercontent.com/cyrian290606/CobbleRealm-Launcher/main/news.json";

let launcherNewsCache = null;

/* Valeurs de secours si le manifest et l'installation sont inconnus. */
const FALLBACK_VERSIONS = {
    minecraft: "1.21.1",
    fabricLoader: "0.18.4",
    java: 21,
    recommendedRamGb: 6
};

const INDEX_URL =
    pathToFileURL(path.join(__dirname, "index.html")).href;


function getCobbleRealmRoot() {

    if (DEV_MODE && process.env.COBBLEREALM_ROOT) {
        return path.resolve(process.env.COBBLEREALM_ROOT);
    }

    return path.join(
        app.getPath("appData"),
        ".cobblerealm"
    );
}


/* ==============================
   SÉCURITÉ IPC
============================== */

/* Seule notre page locale (index.html) a le droit d'appeler le processus principal. */
function isTrustedSender(event) {

    try {

        const url =
            event && event.senderFrame && event.senderFrame.url;

        return (
            typeof url === "string" &&
            url.split(/[?#]/)[0] === INDEX_URL
        );

    } catch {

        return false;
    }
}


function handle(channel, listener) {

    ipcMain.handle(
        channel,

        (event, ...args) => {

            if (!isTrustedSender(event)) {

                console.warn(
                    "[CobbleRealm] Appel IPC refusé (origine inconnue) :",
                    channel
                );

                return {
                    success: false,
                    error: "Appel refusé."
                };
            }

            return listener(event, ...args);
        }
    );
}


function safeMessage(error, fallback) {

    const text =
        error && error.message
            ? error.message
            : fallback;

    return redactSecrets(text);
}


/* ==============================
   MISE À JOUR COBBLEREALM
============================== */

function broadcast(channel, payload) {

    for (const win of BrowserWindow.getAllWindows()) {

        if (win && !win.isDestroyed()) {
            safeSend(win.webContents, channel, payload);
        }
    }
}


function sendLauncherUpdateStatus(status, message) {

    broadcast(
        "launcher-update-status",
        { status, message }
    );
}


let updater = null;

function getUpdater() {

    if (!updater) {

        updater = createUpdater({
            gameRoot: getCobbleRealmRoot(),
            manifestUrl: COBBLEREALM_MANIFEST_URL,
            allowLocal: DEV_MODE,
            onProgress: (event) => broadcast("update-progress", event)
        });
    }

    return updater;
}


function formatSize(bytes) {

    if (bytes >= 1024 ** 3) {
        return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
    }

    return `${Math.max(1, Math.round(bytes / 1048576))} Mo`;
}


/* Résultat partagé entre le démarrage et l'interface : une seule vérification. */
let lastCheck = null;

function describeCheck(check) {

    if (!check) {
        return "Vérification de la version...";
    }

    if (check.fatal) {
        return check.error.message;
    }

    if (check.offline) {

        return check.valid
            ? `Hors-ligne — version installée v${check.installedVersion}`
            : "Impossible de vérifier la mise à jour (hors-ligne)";
    }

    if (check.updateAvailable) {

        return check.filesToDownload > 0
            ? `Mise à jour disponible — v${check.remoteVersion} ` +
              `(${check.filesToDownload} fichier${check.filesToDownload > 1 ? "s" : ""}, ${formatSize(check.bytesToDownload)})`
            : `Mise à jour disponible — v${check.remoteVersion}`;
    }

    return `CobbleRealm à jour — v${check.installedVersion || check.remoteVersion}`;
}


/* ==============================
   ERREURS ET RAPPORT DE SUPPORT
============================== */

const MAX_LOG_LINES = 300;

const privateStrings = new Set();      // pseudo, e-mail du compte : masqués dans tout rapport
const recentLogs = [];                 // dernières lignes du journal (sans jeton)
let lastError = null;                  // { code, message } de la dernière erreur affichée


/* Garde une ligne du journal pour le rapport de support (jetons masqués dès l'entrée). */
function pushLog(text) {

    for (const raw of String(text).split(/\r?\n/)) {

        const line = redactSecrets(raw).trim();

        if (line) {
            recentLogs.push(line.slice(0, 400));
        }
    }

    if (recentLogs.length > MAX_LOG_LINES) {
        recentLogs.splice(0, recentLogs.length - MAX_LOG_LINES);
    }
}


function rememberPrivate(...values) {

    for (const value of values) {

        if (typeof value === "string" && value.trim().length >= 3) {
            privateStrings.add(value.trim());
        }
    }
}


/* Message clair pour le joueur : étape + erreur technique -> { code, title, message, actions }. */
function buildErrorPayload(step, error) {

    const described = describeError({ step, error });

    described.message = sanitize(
        redactSecrets(described.message),
        { privateStrings: [...privateStrings], userNames: currentUserNames() }
    );

    lastError = { code: described.code, message: described.message };

    pushLog(`[Erreur] ${described.code} — ${described.message}`);

    return described;
}


function sendLaunchError(sender, step, error) {

    safeSend(sender, "launch-error", buildErrorPayload(step, error));
}


function broadcastLaunchError(step, error) {

    broadcast("launch-error", buildErrorPayload(step, error));
}


function currentReport() {

    const installed = getUpdater().status();
    const versions = resolveVersions(null);

    return buildReport({
        info: {
            launcher: app.getVersion(),
            pack: installed.version,
            minecraft: versions.minecraft,
            fabric: versions.fabricLoader,
            java: String(versions.java),
            ramAllocatedGb: readLauncherSettings().ram
        },
        error: lastError,
        logs: recentLogs,
        privateStrings: [...privateStrings]
    });
}


/* Une seule vérification à la fois : les appels simultanés partagent la même. */
let checkInFlight = null;

function runCheck() {

    if (!checkInFlight) {

        checkInFlight = (async () => {

            try {

                lastCheck = await getUpdater().check();

            } catch (error) {

                lastCheck = { ok: false, fatal: true, error };
            }

            return lastCheck;

        })().finally(() => { checkInFlight = null; });
    }

    return checkInFlight;
}


/* Versions : manifest si on l'a, sinon dernière installation connue, sinon valeurs de secours. */
function resolveVersions(manifest) {

    const lock = getUpdater().status().lock;
    const source = manifest || lock || {};

    return {
        minecraft: source.minecraft || FALLBACK_VERSIONS.minecraft,
        fabricLoader: source.fabricLoader || FALLBACK_VERSIONS.fabricLoader,
        java: Number(source.java) || FALLBACK_VERSIONS.java,
        recommendedRamGb: Number(source.recommendedRamGb) || FALLBACK_VERSIONS.recommendedRamGb
    };
}


let mainWindow = null;
let launcherSelfUpdater = null;


function getDefaultLauncherNews() {
    return {
        badge: "📣 MISE À JOUR V4",
        title: "Bienvenue sur",
        titleHighlight: "CobbleRealm",
        version: "V4",
        paragraphs: [
            [
                { text: "Découvrez la ", className: "" },
                { text: "V4", className: "cyan" },
                { text: " avec une ", className: "" },
                { text: "refonte complète des raids", className: "cyan" },
                { text: ", ", className: "" },
                { text: "Cobblemon Expeditions", className: "purple" },
                { text: ", de nouvelles ", className: "" },
                { text: "montures Pokémon", className: "orange" },
                { text: ", plus d'informations dans ", className: "" },
                { text: "EMI", className: "green" },
                { text: " et plusieurs ", className: "" },
                { text: "améliorations visuelles", className: "purple" },
                { text: ".", className: "" }
            ]
        ]
    };
}


function normalizeLauncherNews(data) {
    if (!data || typeof data !== "object") {
        return null;
    }

    const fallback = getDefaultLauncherNews();

    const badge =
        typeof data.badge === "string" && data.badge.trim().length > 0
            ? data.badge.trim()
            : fallback.badge;

    const title =
        typeof data.title === "string" && data.title.trim().length > 0
            ? data.title.trim()
            : fallback.title;

    const titleHighlight =
        typeof data.titleHighlight === "string" && data.titleHighlight.trim().length > 0
            ? data.titleHighlight.trim()
            : (
                typeof data.highlight === "string" && data.highlight.trim().length > 0
                    ? data.highlight.trim()
                    : fallback.titleHighlight
            );

    const version =
        typeof data.version === "string" && data.version.trim().length > 0
            ? data.version.trim()
            : fallback.version;

    const sourceParagraphs = Array.isArray(data.paragraphs)
        ? data.paragraphs
        : (
            Array.isArray(data.content)
                ? data.content
                : []
        );

    const paragraphs = sourceParagraphs
        .map((paragraph) => {
            if (Array.isArray(paragraph)) {
                return paragraph
                    .map((part) => {
                        if (typeof part === "string") {
                            return { text: part, className: "" };
                        }

                        if (part && typeof part === "object" && typeof part.text === "string") {
                            return {
                                text: part.text,
                                className: typeof part.className === "string" ? part.className : ""
                            };
                        }

                        return null;
                    })
                    .filter(Boolean);
            }

            if (typeof paragraph === "string") {
                return [{ text: paragraph, className: "" }];
            }

            if (paragraph && typeof paragraph === "object" && typeof paragraph.text === "string") {
                return [{
                    text: paragraph.text,
                    className: typeof paragraph.className === "string" ? paragraph.className : ""
                }];
            }

            return null;
        })
        .filter((paragraph) => Array.isArray(paragraph) && paragraph.length > 0);

    if (paragraphs.length === 0) {
        return {
            badge,
            title,
            titleHighlight,
            version,
            paragraphs: fallback.paragraphs
        };
    }

    return {
        badge,
        title,
        titleHighlight,
        version,
        paragraphs
    };
}


async function fetchLauncherNews() {
    try {
        const response = await fetch(
            COBBLEREALM_NEWS_URL,
            {
                cache: "no-store",
                signal: AbortSignal.timeout(10000)
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const normalized = normalizeLauncherNews(data);

        if (!normalized) {
            throw new Error("JSON de news invalide.");
        }

        return normalized;

    } catch (error) {
        console.warn(
            "[CobbleRealm] Impossible de charger les news distantes, utilisation du fallback local.",
            error
        );

        return getDefaultLauncherNews();
    }
}



/* ==============================
   FENÊTRE PRINCIPALE
============================== */

function createWindow() {

    const win =
        new BrowserWindow({
            width: 1200,
            height: 700,

            minWidth: 900,
            minHeight: 600,

            title:
                "CobbleRealm Launcher",

            backgroundColor:
                "#07111f",

            autoHideMenuBar:
                true,

            webPreferences: {

                preload:
                    path.join(
                        __dirname,
                        "preload.js"
                    ),

                contextIsolation:
                    true,

                nodeIntegration:
                    false,

                sandbox:
                    true,

                webSecurity:
                    true
            }
        });

    mainWindow = win;

    /* L'interface ne doit jamais ouvrir de fenêtre ni naviguer ailleurs. */
    win.webContents.setWindowOpenHandler(
        () => ({ action: "deny" })
    );

    win.webContents.on(
        "will-navigate",
        (event, url) => {

            if (url.split(/[?#]/)[0] !== INDEX_URL) {
                event.preventDefault();
            }
        }
    );

    win.loadFile(
        path.join(
            __dirname,
            "index.html"
        )
    );
}


/* ==============================
   CONNEXION MICROSOFT
============================== */

handle(
    "microsoft-login",

    async (event) => {

        const result =
            await loginMicrosoft(
                createDeviceCodeHandler(event.sender)
            );

        return result;
    }
);

handle(
    "microsoft-session",

    async () => {

        return await
            getMicrosoftSession();
    }
);

handle(
    "microsoft-logout",

    async () => {

        return await
            logoutMicrosoft();
    }
);


/* ==============================
   TEST MINECRAFT SERVICES
============================== */

handle(
    "minecraft-test",

    async (event) => {

        try {

            const microsoftResult =
                await loginMicrosoft(
                    createDeviceCodeHandler(event.sender)
                );

            /* Ferme la fenêtre de code, qu'elle ait servi ou non. */
            safeSend(
                event.sender,
                "microsoft-device-code",
                null
            );

            if (
                !microsoftResult ||
                !microsoftResult.success ||
                !microsoftResult.accessToken
            ) {

                return {
                    success: false,

                    step:
                        "microsoft",

                    error:
                        microsoftResult &&
                        microsoftResult.error
                            ? redactSecrets(microsoftResult.error)
                            : "Impossible de récupérer un token Microsoft."
                };
            }

            const minecraftResult =
                await loginMinecraft(
                    microsoftResult.accessToken
                );

            return minecraftResult;

        } catch (error) {

            console.error(
                "[Minecraft Test] Erreur :",
                redactSecrets(error && error.stack ? error.stack : error)
            );

            return {
                success: false,

                step:
                    "launcher",

                error:
                    safeMessage(error, "Erreur inconnue pendant le test Minecraft.")
            };
        }
    }
);


/* ==============================
   PARAMÈTRES DU LAUNCHER
============================== */

function getSettingsPath() {

    return path.join(
        app.getPath(
            "userData"
        ),
        "settings.json"
    );
}


/*
 * Défaut de RAM : la valeur recommandée par le manifest (dernière connue),
 * limitée à ce que la machine peut offrir ; 4 Go maximum sous 12 Go de RAM.
 */
function getDefaultRam() {

    const limits =
        getRamLimits();

    const lock =
        getUpdater().status().lock;

    const recommended =
        lock && Number(lock.recommendedRamGb);

    if (!recommended) {
        return limits.defaultRam;
    }

    const totalGb =
        os.totalmem() / (1024 ** 3);

    return Math.min(
        limits.maxRam,
        totalGb >= 12 ? recommended : 4
    );
}


function readLauncherSettings() {

    try {

        const settingsPath =
            getSettingsPath();

        if (
            !fs.existsSync(
                settingsPath
            )
        ) {

            return {
                ram: getDefaultRam()
            };
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    settingsPath,
                    "utf8"
                )
            );

        return {
            ram: clampRam(data.ram)
        };

    } catch (error) {

        console.error(
            "[CobbleRealm] Erreur lecture paramètres :",
            error
        );

        return {
            ram: getDefaultRam()
        };
    }
}


handle(
    "get-launcher-settings",

    async () => {

        const limits =
            getRamLimits();

        return {
            ...readLauncherSettings(),
            minRam: limits.minRam,
            maxRam: limits.maxRam,
            defaultRam: getDefaultRam()
        };
    }
);


handle(
    "save-launcher-settings",

    async (
        event,
        settings = {}
    ) => {

        try {

            const ram =
                clampRam(settings.ram);

            fs.writeFileSync(
                getSettingsPath(),

                JSON.stringify(
                    {
                        ram:
                            ram
                    },
                    null,
                    2
                ),

                "utf8"
            );

            return {
                success: true,
                ram: ram
            };

        } catch (error) {

            console.error(
                "[CobbleRealm] Erreur sauvegarde paramètres :",
                error
            );

            return {
                success: false,
                error:
                    safeMessage(error, "Impossible d'enregistrer les paramètres.")
            };
        }
    }
);


/* ==============================
   STATUT DE LA VERSION
   (même module et même requête que la mise à jour)
============================== */

handle(
    "check-cobblerealm-update",

    async () => {

        const check =
            lastCheck || await runCheck();

        if (check.fatal) {

            return {
                success: false,
                error: check.error.message,
                message: describeCheck(check)
            };
        }

        return {
            success: true,

            localVersion:
                check.installedVersion,

            remoteVersion:
                check.remoteVersion,

            updateAvailable:
                check.updateAvailable,

            offline:
                Boolean(check.offline),

            filesToDownload:
                check.filesToDownload || 0,

            bytesToDownload:
                check.bytesToDownload || 0,

            message:
                describeCheck(check)
        };
    }
);


handle(
    "get-launcher-news",

    async () => {
        if (!launcherNewsCache) {
            launcherNewsCache = await fetchLauncherNews();
        }

        return launcherNewsCache;
    }
);


/* ==============================
   RÉPARATION DE L'INSTALLATION
============================== */

handle(
    "repair-installation",

    async (event) => {

        if (launchInProgress) {

            return {
                success: false,
                error: "Une opération est déjà en cours."
            };
        }

        launchInProgress = true;

        try {

            const result =
                await getUpdater().repair();

            lastCheck = {
                ok: true,
                offline: false,
                valid: true,
                installedVersion: result.version,
                remoteVersion: result.version,
                updateAvailable: false
            };

            sendLauncherUpdateStatus(
                "ready",
                describeCheck(lastCheck)
            );

            return {
                success: true,
                version: result.version
            };

        } catch (error) {

            sendLaunchError(
                event.sender,
                "update",
                error
            );

            return {
                success: false,
                error: safeMessage(error, "La réparation a échoué."),
                code: error.code
            };

        } finally {

            launchInProgress = false;
        }
    }
);


/* ==============================
   RAPPORT DE SUPPORT
   (jetons, e-mail, pseudo, identifiants et chemins personnels sont masqués)
============================== */

handle(
    "copy-support-report",

    async () => {

        try {

            const report = currentReport();

            clipboard.writeText(report);

            return {
                success: true,
                lines: report.split("\n").length
            };

        } catch (error) {

            return {
                success: false,
                error: "Impossible de copier le rapport."
            };
        }
    }
);


/* ==============================
   MISE À JOUR DU LAUNCHER
============================== */

handle(
    "install-launcher-update",

    async () => {

        if (launchInProgress || !launcherSelfUpdater) {

            return {
                success: false,
                error: "Impossible d'installer la mise à jour pour le moment."
            };
        }

        launcherSelfUpdater.installNow();

        return { success: true };
    }
);


/* ==============================
   LANCEMENT MINECRAFT
============================== */

handle(
    "launch-minecraft",

    async (
        event,
        launchOptions = {}
    ) => {

        if (launchInProgress) {

            return {
                success: false,
                step: "launch",
                error: "Minecraft est déjà en cours de lancement."
            };
        }

        launchInProgress = true;

        let removeGameListeners = () => {};
        let step = "update";

        let gameStarted = false;

        const status = (message) => {

            pushLog(`[Launcher] ${message}`);

            safeSend(
                event.sender,
                "minecraft-status",
                { type: "status", message }
            );
        };

        const relayLog = (message) => {

            pushLog(message);

            safeSend(
                event.sender,
                "minecraft-log",
                message
            );
        };

        try {

            console.log(
                "[CobbleRealm] Préparation du lancement..."
            );


            /*
             * 1) MISE À JOUR DU MODPACK
             * Le jeu ne démarre JAMAIS tant que cette étape n'a pas réussi.
             */

            status("Vérification de la mise à jour...");

            const syncResult =
                await getUpdater().sync();

            if (syncResult.offline) {

                safeSend(
                    event.sender,
                    "update-warning",
                    {
                        message:
                            `Hors-ligne : lancement de la version installée (v${syncResult.version}). ` +
                            "Certaines nouveautés peuvent manquer."
                    }
                );
            }

            let manifest = null;

            if (!syncResult.offline) {

                try {
                    manifest = await getUpdater().getManifest();
                } catch { /* on retombera sur la dernière installation connue */ }

                lastCheck = {
                    ok: true,
                    offline: false,
                    valid: true,
                    installedVersion: syncResult.version,
                    remoteVersion: syncResult.version,
                    updateAvailable: false
                };

                sendLauncherUpdateStatus(
                    "ready",
                    describeCheck(lastCheck)
                );
            }

            const versions =
                resolveVersions(manifest);

            step = "microsoft";


            /*
             * 2) TOKEN MICROSOFT
             * (affiche le code d'appareil si la session a expiré)
             */

            const microsoftResult =
                await loginMicrosoft(
                    createDeviceCodeHandler(event.sender)
                );

            /* Ferme la fenêtre de code, qu'elle ait servi ou non. */
            safeSend(
                event.sender,
                "microsoft-device-code",
                null
            );

            if (
                !microsoftResult ||
                !microsoftResult.success ||
                !microsoftResult.accessToken
            ) {

                const failure = new Error(
                    microsoftResult && microsoftResult.error
                        ? redactSecrets(microsoftResult.error)
                        : "Connexion Microsoft impossible."
                );

                failure.code = microsoftResult && microsoftResult.code;

                throw failure;
            }

            /* Le compte et le pseudo ne doivent jamais apparaître dans un rapport. */
            rememberPrivate(
                microsoftResult.account && microsoftResult.account.username
            );

            step = "minecraft-auth";


            /*
             * 3) TOKEN MINECRAFT
             */

            const minecraftResult =
                await loginMinecraft(
                    microsoftResult.accessToken,
                    relayLog
                );

            if (
                !minecraftResult ||
                !minecraftResult.success
            ) {

                launchInProgress = false;

                const authError = {
                    status:
                        minecraftResult
                            ? minecraftResult.status
                            : null,

                    message:
                        minecraftResult && minecraftResult.error
                            ? redactSecrets(minecraftResult.error)
                            : "Impossible de se connecter à Minecraft Services."
                };

                const payload =
                    buildErrorPayload("minecraft-auth", authError);

                safeSend(event.sender, "launch-error", payload);

                safeSend(
                    event.sender,
                    "minecraft-status",
                    { type: "error", message: payload.message }
                );

                return {
                    success:
                        false,

                    step:
                        "minecraft-auth",

                    code:
                        payload.code,

                    error:
                        payload.message,

                    status:
                        authError.status
                };
            }

            if (
                !minecraftResult.accessToken ||
                !minecraftResult.profile
            ) {

                throw new Error(
                    "Le profil Minecraft est incomplet."
                );
            }

            const profile =
                minecraftResult.profile;

            rememberPrivate(profile.name, profile.id);

            step = "java";


            /*
             * 4) JAVA ET FABRIC (versions données par le manifest)
             */

            const gameRoot =
                getCobbleRealmRoot();

            const javaPath =
                await ensureJava({
                    runtimeRoot: path.join(gameRoot, "runtime"),
                    required: versions.java,
                    allowLocal: DEV_MODE,
                    onStatus: status
                });

            console.log(
                "[CobbleRealm] Java utilisé :",
                javaPath
            );

            step = "fabric";

            status(`Préparation de Fabric ${versions.fabricLoader}...`);

            const fabricProfileId =
                await ensureFabricProfile({
                    root: gameRoot,
                    minecraft: versions.minecraft,
                    fabricLoader: versions.fabricLoader,
                    allowLocal: DEV_MODE,
                    onLog: relayLog
                });

            step = "launch";


            /*
             * 5) OPTIONS DE LANCEMENT
             */

            const ram =
                clampRam(launchOptions.ram || versions.recommendedRamGb);

            const options = {

                javaPath:
                    javaPath,

                authorization: {

                    access_token:
                        minecraftResult.accessToken,

                    client_token:
                        "",

                    uuid:
                        profile.id,

                    name:
                        profile.name,

                    user_properties:
                        "{}",

                    meta: {
                        type:
                            "msa"
                    }
                },

                root:
                    gameRoot,

                version: {

                    number:
                        versions.minecraft,

                    type:
                        "release",

                    custom:
                        fabricProfileId
                },

                memory: {

                    max:
                        `${ram}G`,

                    min:
                        `${Math.min(2, ram)}G`
                }
            };

            console.log(
                "[CobbleRealm] RAM envoyée à Minecraft :",
                options.memory.max
            );


            /*
             * 6) ÉVÉNEMENTS
             * Les écouteurs sont retirés dès la fermeture du jeu
             * (ou en cas d'échec) pour ne jamais s'accumuler.
             * Tout texte est masqué (jeton) avant affichage.
             */

            const debugListener =
                (
                    data
                ) => {

                    const message =
                        redactSecrets(data);

                    console.log(
                        "[Minecraft DEBUG]",
                        message
                    );

                    pushLog(message);

                    safeSend(
                        event.sender,
                        "minecraft-log",
                        message
                    );
                };

            const dataListener =
                (
                    data
                ) => {

                    const message =
                        redactSecrets(data);

                    console.log(
                        "[Minecraft]",
                        message
                    );

                    pushLog(message);

                    safeSend(
                        event.sender,
                        "minecraft-log",
                        message
                    );
                };

            const progressListener =
                (
                    progress
                ) => {

                    safeSend(
                        event.sender,
                        "minecraft-progress",
                        progress
                    );
                };

            const closeListener =
                (code) => {

                    console.log(
                        "[CobbleRealm] Minecraft fermé. Code :",
                        code
                    );

                    safeSend(
                        event.sender,
                        "minecraft-status",
                        {
                            type: "closed",
                            message: "Minecraft fermé."
                        }
                    );

                    /*
                     * Arrêt avec une erreur : on prévient le joueur (une fois le jeu réellement démarré :
                     * un échec de démarrage est signalé plus bas par l'erreur de lancement).
                     */
                    if (gameStarted && code !== 0 && code !== null && code !== undefined) {

                        sendLaunchError(
                            event.sender,
                            "game-exit",
                            { exitCode: code }
                        );
                    }

                    removeGameListeners();
                };

            removeGameListeners = () => {

                launcher.removeListener("debug", debugListener);
                launcher.removeListener("data", dataListener);
                launcher.removeListener("progress", progressListener);
                launcher.removeListener("close", closeListener);

                launchInProgress = false;
            };

            launcher.on("debug", debugListener);
            launcher.on("data", dataListener);
            launcher.on("progress", progressListener);
            launcher.on("close", closeListener);


            /*
             * 7) LANCEMENT
             */

            status("Lancement de Minecraft...");

            const gameProcess =
                await launcher.launch(
                    options
                );

            if (!gameProcess) {

                throw new Error(
                    "Minecraft n'a pas pu démarrer. Vérifie ton installation puis réessaie."
                );
            }

            gameStarted = true;

            safeSend(
                event.sender,
                "minecraft-status",
                {
                    type:
                        "success",

                    message:
                        "Minecraft lancé."
                }
            );

            return {
                success:
                    true,

                profile: {
                    id:
                        profile.id,

                    name:
                        profile.name
                }
            };

        } catch (error) {

            console.error(
                "[CobbleRealm] Erreur lancement :",
                redactSecrets(error && error.stack ? error.stack : error)
            );

            removeGameListeners();
            launchInProgress = false;

            /* Message clair + actions (Réessayer, Réparer, Copier le rapport, Aide) selon l'étape qui a échoué. */
            const payload =
                buildErrorPayload(step, error);

            safeSend(
                event.sender,
                "launch-error",
                payload
            );

            safeSend(
                event.sender,
                "minecraft-status",
                {
                    type:
                        "error",

                    message:
                        payload.message
                }
            );

            return {
                success:
                    false,

                step:
                    step,

                code:
                    payload.code,

                error:
                    payload.message
            };
        }
    }
);


/* ==============================
   LIENS EXTERNES (adresses fixes)
============================== */

function openFixedLink(channel, url) {

    handle(
        channel,

        async () => {

            try {

                await shell.openExternal(url);

                return {
                    success: true
                };

            } catch (error) {

                return {
                    success: false,
                    error:
                        safeMessage(error, "Impossible d'ouvrir le lien.")
                };
            }
        }
    );
}

openFixedLink("open-discord", "https://discord.gg/CyA4Qc9NAC");
openFixedLink("open-site", "https://cobblerealm.gitbook.io/cobblerealm-docs");
openFixedLink("open-shop", "https://cobblerealm-beta.tebex.store/");


/* ==============================
   ELECTRON
============================== */

app.whenReady().then(
    async () => {

        /* Deuxième instance : on laisse la première gérer. */
        if (!hasSingleInstanceLock) {
            return;
        }

        /*
         * OUVERTURE IMMÉDIATE DU LAUNCHER
         */

        createWindow();

        const win =
            BrowserWindow
                .getAllWindows()[0];

        if (win) {

            await new Promise(
                (
                    resolve
                ) => {

                    if (
                        win.webContents
                            .isLoading()
                    ) {

                        win.webContents.once(
                            "did-finish-load",
                            resolve
                        );

                    } else {

                        resolve();
                    }
                }
            );
        }

        /*
         * Mise à jour du launcher lui-même (application installée uniquement).
         */

        launcherSelfUpdater = initLauncherUpdates({
            app,
            notify: (info) => broadcast("launcher-self-update", info)
        });

        /*
         * VÉRIFICATION DU MODPACK (lecture seule : rien n'est téléchargé ici).
         * Le téléchargement se fait au clic sur JOUER, avant le lancement du jeu.
         */

        launcherNewsCache = await fetchLauncherNews();

        sendLauncherUpdateStatus(
            "checking",
            "VÉRIFICATION..."
        );

        const check =
            await runCheck();

        if (check.fatal) {

            broadcastLaunchError(
                "update",
                check.error
            );
        }

        sendLauncherUpdateStatus(
            "ready",
            describeCheck(check)
        );

        console.log(
            "[CobbleRealm] Vérification terminée :",
            describeCheck(check)
        );

        app.on(
            "activate",

            () => {

                if (
                    BrowserWindow
                        .getAllWindows()
                        .length === 0
                ) {

                    createWindow();
                }
            }
        );
    }
);


/* ==============================
   FERMETURE
============================== */

app.on(
    "window-all-closed",

    () => {

        if (
            process.platform !==
            "darwin"
        ) {

            app.quit();
        }
    }
);
