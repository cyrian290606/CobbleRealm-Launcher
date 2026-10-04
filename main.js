const {
    app,
    BrowserWindow,
    Menu,
    ipcMain,
    shell
} = require("electron");

const path = require("path");
const fs = require("fs");
const extract = require("extract-zip");

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


/* ==============================
   CONFIGURATION
============================== */

Menu.setApplicationMenu(null);

const launcher = new Client();

const COBBLEREALM_MANIFEST_URL =
    "https://raw.githubusercontent.com/cyrian290606/CobbleRealm-Launcher/main/manifest.json";

const COBBLEREALM_NEWS_URL =
    "https://raw.githubusercontent.com/cyrian290606/CobbleRealm-Launcher/main/news.json";

let launcherNewsCache = null;

const MINECRAFT_VERSION =
    "1.21.1";

const FABRIC_LOADER_VERSION =
    "0.18.4";

const FABRIC_PROFILE_ID =
    `fabric-loader-${FABRIC_LOADER_VERSION}-${MINECRAFT_VERSION}`;

const FABRIC_PROFILE_URL =
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(MINECRAFT_VERSION)}/${encodeURIComponent(FABRIC_LOADER_VERSION)}/profile/json`;



/* ==============================
   MISE À JOUR COBBLEREALM
============================== */

function getCobbleRealmRoot() {

    return path.join(
        app.getPath("appData"),
        ".cobblerealm"
    );
}


function getLocalVersionPath() {

    return path.join(
        getCobbleRealmRoot(),
        "version.json"
    );
}


function readLocalCobbleRealmVersion() {

    try {

        const versionPath =
            getLocalVersionPath();

        if (
            !fs.existsSync(
                versionPath
            )
        ) {
            return "0.0.0";
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    versionPath,
                    "utf8"
                )
            );

        return (
            data.version ||
            "0.0.0"
        );

    } catch (error) {

        console.error(
            "[CobbleRealm] Erreur lecture version locale :",
            error
        );

        return "0.0.0";
    }
}


async function getRemoteCobbleRealmManifest() {

    const manifestUrl =
    `${COBBLEREALM_MANIFEST_URL}?t=${Date.now()}`;

const response =
    await fetch(
        manifestUrl,
        {
            cache: "no-store"
        }
    );

    if (!response.ok) {

        throw new Error(
            `Impossible de récupérer le manifest CobbleRealm (${response.status})`
        );
    }

    return await response.json();
}


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
                cache: "no-store"
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


function compareVersions(
    currentVersion,
    remoteVersion
) {

    const current =
        String(
            currentVersion
        )
            .split(".")
            .map(Number);

    const remote =
        String(
            remoteVersion
        )
            .split(".")
            .map(Number);

    const length =
        Math.max(
            current.length,
            remote.length
        );

    for (
        let i = 0;
        i < length;
        i++
    ) {

        const a =
            current[i] || 0;

        const b =
            remote[i] || 0;

        if (a < b) {
            return -1;
        }

        if (a > b) {
            return 1;
        }
    }

    return 0;
}


async function checkCobbleRealmUpdate() {

    const localVersion =
        readLocalCobbleRealmVersion();

    const manifest =
        await getRemoteCobbleRealmManifest();

    const remoteVersion =
        manifest.version ||
        "0.0.0";

    const comparison =
        compareVersions(
            localVersion,
            remoteVersion
        );

    return {
        localVersion:
            localVersion,

        remoteVersion:
            remoteVersion,

        updateAvailable:
            comparison < 0,

        manifest:
            manifest
    };
}


async function downloadCobbleRealmPack(
    url,
    destination
) {

    console.log(
        "[CobbleRealm] Téléchargement du pack..."
    );

    const response =
        await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Erreur téléchargement CobbleRealm (${response.status})`
        );
    }

    if (!response.body) {
        throw new Error(
            "Le serveur n'a retourné aucun contenu."
        );
    }

    const totalBytes =
        Number(response.headers.get("content-length")) || 0;

    const reader =
        response.body.getReader();

    const fileStream =
        fs.createWriteStream(destination);

    let downloadedBytes = 0;
    let lastPercent = -1;

    try {

        while (true) {

            const {
                done,
                value
            } = await reader.read();

            if (done) {
                break;
            }

            await new Promise(
                (resolve, reject) => {

                    fileStream.write(
                        Buffer.from(value),
                        (error) => {

                            if (error) {
                                reject(error);
                            } else {
                                resolve();
                            }
                        }
                    );
                }
            );

            downloadedBytes += value.byteLength;

            if (totalBytes > 0) {

                const percent =
                    Math.floor(
                        (downloadedBytes / totalBytes) * 100
                    );

                if (percent !== lastPercent) {

                    lastPercent = percent;

                    console.log(
                        `[CobbleRealm] Téléchargement : ${percent}%`
                    );
                }
            }
        }

        await new Promise(
            (resolve, reject) => {

                fileStream.end(
                    (error) => {

                        if (error) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    }
                );
            }
        );

    } catch (error) {

        fileStream.destroy();

        try {
            fs.rmSync(
                destination,
                {
                    force: true
                }
            );
        } catch {}

        throw error;
    }

    console.log(
        "[CobbleRealm] Téléchargement terminé :",
        destination
    );

    return destination;
}

async function downloadLatestCobbleRealmPack(
    manifest
) {

    if (
        !manifest ||
        !Array.isArray(manifest.downloads) ||
        manifest.downloads.length === 0
    ) {
        throw new Error(
            "Aucune URL de téléchargement dans le manifest CobbleRealm."
        );
    }

    const zipPaths = [];

    for (let i = 0; i < manifest.downloads.length; i++) {

        const tempZipPath = path.join(
            app.getPath("temp"),
            `CobbleRealm-update-part${i + 1}.zip`
        );

        if (fs.existsSync(tempZipPath)) {
            fs.rmSync(tempZipPath, {
                force: true
            });
        }

        console.log(
            `[CobbleRealm] Téléchargement partie ${i + 1}/${manifest.downloads.length}...`
        );

        await downloadCobbleRealmPack(
            manifest.downloads[i],
            tempZipPath
        );

        zipPaths.push(tempZipPath);
    }

    return zipPaths;
}


async function extractCobbleRealmPack(zipPaths) {

    const gameRoot = getCobbleRealmRoot();

    if (!fs.existsSync(gameRoot)) {
        fs.mkdirSync(gameRoot, {
            recursive: true
        });
    }

    if (!Array.isArray(zipPaths) || zipPaths.length === 0) {
        throw new Error(
            "Aucune archive CobbleRealm à installer."
        );
    }

    console.log(
        `[CobbleRealm] Vérification de ${zipPaths.length} archive(s)...`
    );

    // ==============================
    // TEST DES ZIP
    // ==============================

    for (let i = 0; i < zipPaths.length; i++) {

        const tempExtractPath = path.join(
            app.getPath("temp"),
            `CobbleRealm-extract-test-${i + 1}`
        );

        fs.rmSync(tempExtractPath, {
            recursive: true,
            force: true
        });

        fs.mkdirSync(tempExtractPath, {
            recursive: true
        });

        try {

            console.log(
                `[CobbleRealm] Vérification ZIP ${i + 1}/${zipPaths.length}...`
            );

            await extract(
                zipPaths[i],
                {
                    dir: tempExtractPath
                }
            );

            console.log(
                `[CobbleRealm] ZIP ${i + 1} valide.`
            );

        } catch (error) {

            console.error(
                `[CobbleRealm] ZIP ${i + 1} invalide :`,
                error
            );

            throw new Error(
                `La partie ${i + 1} de la mise à jour est corrompue. Installation annulée.`
            );

        } finally {

            fs.rmSync(tempExtractPath, {
                recursive: true,
                force: true
            });
        }
    }

    // ==============================
    // SAUVEGARDE FICHIERS JOUEUR
    // ==============================

    const preservedFiles = [
        "options.txt",
        "optionsof.txt",
        "servers.dat"
    ];

    const preservedData = new Map();

    for (const fileName of preservedFiles) {

        const filePath = path.join(
            gameRoot,
            fileName
        );

        if (fs.existsSync(filePath)) {

            try {

                preservedData.set(
                    fileName,
                    fs.readFileSync(filePath)
                );

                console.log(
                    "[CobbleRealm] Sauvegarde fichier joueur :",
                    fileName
                );

            } catch (error) {

                console.error(
                    "[CobbleRealm] Erreur sauvegarde :",
                    fileName,
                    error
                );
            }
        }
    }

    // ==============================
    // SUPPRESSION ANCIEN MODPACK
    // ==============================

    const foldersToSync = [
        "mods",
        "config",
        "defaultconfigs",
        "resourcepacks",
        "shaderpacks",
        "datapacks",
        "global_packs",
        "scripts",
        "fancymenu_data",
        "slideshow"
    ];

    for (const folderName of foldersToSync) {

        const folderPath = path.join(
            gameRoot,
            folderName
        );

        if (fs.existsSync(folderPath)) {

            console.log(
                `[CobbleRealm] Suppression ancien dossier : ${folderName}`
            );

            fs.rmSync(folderPath, {
                recursive: true,
                force: true
            });
        }
    }

    // ==============================
    // EXTRACTION PART1 + PART2
    // ==============================

    for (let i = 0; i < zipPaths.length; i++) {

        console.log(
            `[CobbleRealm] Installation partie ${i + 1}/${zipPaths.length}...`
        );

        await extract(
            zipPaths[i],
            {
                dir: gameRoot
            }
        );
    }

    // ==============================
    // RESTAURATION FICHIERS JOUEUR
    // ==============================

    for (const [fileName, data] of preservedData.entries()) {

        const filePath = path.join(
            gameRoot,
            fileName
        );

        try {

            fs.writeFileSync(
                filePath,
                data
            );

            console.log(
                "[CobbleRealm] Fichier joueur restauré :",
                fileName
            );

        } catch (error) {

            console.error(
                "[CobbleRealm] Erreur restauration :",
                fileName,
                error
            );
        }
    }

    // ==============================
    // SUPPRESSION MOD INCOMPATIBLE
    // ==============================

    const incompatibleMods = [
        "seasonhud-fabric-1.21.1-1.13.8.jar"
    ];

    for (const modFile of incompatibleMods) {

        const modPath = path.join(
            gameRoot,
            "mods",
            modFile
        );

        if (fs.existsSync(modPath)) {

            fs.rmSync(
                modPath,
                {
                    force: true
                }
            );

            console.log(
                `[CobbleRealm] Mod incompatible supprimé : ${modFile}`
            );
        }
    }

    // ==============================
    // SUPPRESSION ZIP TEMPORAIRES
    // ==============================

    for (const zipPath of zipPaths) {

        try {

            fs.rmSync(
                zipPath,
                {
                    force: true
                }
            );

        } catch (error) {

            console.warn(
                "[CobbleRealm] Impossible de supprimer :",
                zipPath
            );
        }
    }

    console.log(
        "[CobbleRealm] Installation complète terminée :",
        gameRoot
    );

    return gameRoot;
}


function writeLocalCobbleRealmVersion(
    version
) {

    const gameRoot =
        getCobbleRealmRoot();

    if (
        !fs.existsSync(
            gameRoot
        )
    ) {

        fs.mkdirSync(
            gameRoot,
            {
                recursive: true
            }
        );
    }

    const versionPath =
        getLocalVersionPath();

    fs.writeFileSync(
        versionPath,

        JSON.stringify(
            {
                version:
                    String(
                        version
                    )
            },
            null,
            2
        ),

        "utf8"
    );
}


/* ==============================
   FABRIC
============================== */

function getFabricProfilePath() {

    return path.join(
        getCobbleRealmRoot(),
        "versions",
        FABRIC_PROFILE_ID,
        `${FABRIC_PROFILE_ID}.json`
    );
}


function getFabricProfileJarPath() {

    return path.join(
        getCobbleRealmRoot(),
        "versions",
        FABRIC_PROFILE_ID,
        `${FABRIC_PROFILE_ID}.jar`
    );
}


async function ensureFabricProfile() {

    const profilePath =
        getFabricProfilePath();

    if (
        fs.existsSync(
            profilePath
        )
    ) {

        console.log(
            "[CobbleRealm] Profil Fabric déjà présent :",
            profilePath
        );

        return profilePath;
    }

    console.log(
        "[CobbleRealm] Profil Fabric absent. Installation automatique..."
    );

    const response =
        await fetch(
            FABRIC_PROFILE_URL
        );

    if (
        !response.ok
    ) {

        throw new Error(
            `Impossible de télécharger le profil Fabric (${response.status})`
        );
    }

    const profile =
        await response.json();

    const profileDir =
        path.dirname(
            profilePath
        );

    if (
        !fs.existsSync(
            profileDir
        )
    ) {

        fs.mkdirSync(
            profileDir,
            {
                recursive: true
            }
        );
    }

    fs.writeFileSync(
        profilePath,

        JSON.stringify(
            profile,
            null,
            2
        ),

        "utf8"
    );

    console.log(
        "[CobbleRealm] Profil Fabric installé :",
        profilePath
    );

    return profilePath;
}


function getVanillaVersionJarPath() {

    return path.join(
        getCobbleRealmRoot(),
        "versions",
        MINECRAFT_VERSION,
        `${MINECRAFT_VERSION}.jar`
    );
}


function ensureFabricJarCompatibility() {

    const fabricJarPath =
        getFabricProfileJarPath();

    if (
        fs.existsSync(
            fabricJarPath
        )
    ) {

        return fabricJarPath;
    }

    const vanillaJarPath =
        getVanillaVersionJarPath();

    if (
        !fs.existsSync(
            vanillaJarPath
        )
    ) {

        console.warn(
            "[CobbleRealm] JAR vanilla absent pour compatibilité Fabric :",
            vanillaJarPath
        );

        return null;
    }

    const fabricDir =
        path.dirname(
            fabricJarPath
        );

    if (
        !fs.existsSync(
            fabricDir
        )
    ) {

        fs.mkdirSync(
            fabricDir,
            {
                recursive: true
            }
        );
    }

    fs.copyFileSync(
        vanillaJarPath,
        fabricJarPath
    );

    console.log(
        "[CobbleRealm] JAR Fabric de compatibilité créé :",
        fabricJarPath
    );

    return fabricJarPath;
}


/* ==============================
   FENÊTRE PRINCIPALE
============================== */

let mainWindow = null;

function createMainWindow() {

    mainWindow = new BrowserWindow({

        width: 1280,
        height: 720,

        minWidth: 1100,
        minHeight: 650,

        show: false,

        backgroundColor: "#050914",

        webPreferences: {

            preload:
                path.join(
                    __dirname,
                    "preload.js"
                ),

            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(
        "index.html"
    );

    mainWindow.once(
        "ready-to-show",
        () => {

            mainWindow.show();
        }
    );

    mainWindow.on(
        "closed",
        () => {

            mainWindow = null;
        }
    );
}


function sendLauncherUpdateStatus(
    status,
    message
) {

    if (
        mainWindow &&
        !mainWindow.isDestroyed()
    ) {

        mainWindow.webContents.send(
            "launcher-update-status",
            {
                status,
                message
            }
        );
    }
}


/* ==============================
   MICROSOFT AUTHENTICATION
============================== */

async function handleMicrosoftLogin() {

    const result =
        await loginMicrosoft();

    return result;
}


async function handleMicrosoftSession() {

    const session =
        await getMicrosoftSession();

    return session;
}


async function handleMicrosoftLogout() {

    const result =
        await logoutMicrosoft();

    return result;
}


/* ==============================
   LANCEMENT MINECRAFT
============================== */

async function launchMinecraftGame() {

    console.log(
        "[CobbleRealm] Préparation du lancement Minecraft..."
    );

    const session =
        await getMicrosoftSession();

    if (
        !session ||
        !session.account
    ) {

        throw new Error(
            "Aucune session Microsoft active."
        );
    }

    const minecraftAuth =
        await loginMinecraft(
            session.account
        );

    if (
        !minecraftAuth ||
        !minecraftAuth.access_token ||
        !minecraftAuth.uuid ||
        !minecraftAuth.name
    ) {

        throw new Error(
            "Impossible de récupérer la session Minecraft."
        );
    }

    const root =
        getCobbleRealmRoot();

    await ensureFabricProfile();

    const opts = {

        authorization: {

            access_token:
                minecraftAuth.access_token,

            client_token:
                minecraftAuth.uuid,

            uuid:
                minecraftAuth.uuid,

            name:
                minecraftAuth.name,

            user_properties: {}
        },

        root:
            root,

        version: {

            number:
                MINECRAFT_VERSION,

            type:
                "release",

            custom:
                FABRIC_PROFILE_ID
        },

        memory: {

            max:
                "8G",

            min:
                "4G"
        }
    };

    console.log(
        "[CobbleRealm] Lancement avec :",
        {
            root,
            profile:
                FABRIC_PROFILE_ID,
            player:
                minecraftAuth.name
        }
    );

    launcher.launch(
        opts
    );

    return {
        success: true
    };
}


launcher.on(
    "debug",
    (data) => {

        console.log(
            "[Minecraft Debug]",
            data
        );
    }
);


launcher.on(
    "data",
    (data) => {

        console.log(
            "[Minecraft]",
            data
        );
    }
);


launcher.on(
    "progress",
    (data) => {

        console.log(
            "[Minecraft Progress]",
            data
        );
    }
);


launcher.on(
    "close",
    (code) => {

        console.log(
            "[Minecraft] Processus fermé avec le code :",
            code
        );
    }
);


/* ==============================
   IPC
============================== */

ipcMain.handle(
    "microsoft-login",
    async () => {

        return await handleMicrosoftLogin();
    }
);


ipcMain.handle(
    "microsoft-session",
    async () => {

        return await handleMicrosoftSession();
    }
);


ipcMain.handle(
    "microsoft-logout",
    async () => {

        return await handleMicrosoftLogout();
    }
);


ipcMain.handle(
    "launch-minecraft",
    async () => {

        try {

            return await launchMinecraftGame();

        } catch (error) {

            console.error(
                "[CobbleRealm] Erreur lancement Minecraft :",
                error
            );

            return {
                success: false,
                error:
                    error.message
            };
        }
    }
);


ipcMain.handle(
    "open-external",
    async (
        event,
        url
    ) => {

        try {

            await shell.openExternal(
                url
            );

            return {
                success: true
            };

        } catch (error) {

            console.error(
                "[CobbleRealm] Erreur ouverture URL :",
                error
            );

            return {
                success: false,
                error:
                    error.message
            };
        }
    }
);


ipcMain.handle(
    "launcher-news",
    async () => {

        if (launcherNewsCache) {
            return launcherNewsCache;
        }

        launcherNewsCache = await fetchLauncherNews();
        return launcherNewsCache;
    }
);


/* ==============================
   APPLICATION
============================== */

app.whenReady().then(
    async () => {

        createMainWindow();

        try {

            launcherNewsCache = await fetchLauncherNews();

            if (
                mainWindow &&
                !mainWindow.isDestroyed()
            ) {

                mainWindow.webContents.once(
                    "did-finish-load",
                    () => {

                        if (
                            mainWindow &&
                            !mainWindow.isDestroyed()
                        ) {

                            mainWindow.webContents.send(
                                "launcher-news-updated",
                                launcherNewsCache
                            );
                        }
                    }
                );
            }

        } catch (error) {

            console.error(
                "[CobbleRealm] Erreur chargement news :",
                error
            );
        }

        try {

            sendLauncherUpdateStatus(
                "checking",
                "VÉRIFICATION..."
            );

            const result =
                await checkCobbleRealmUpdate();

            console.log(
                "[CobbleRealm] Version locale :",
                result.localVersion
            );

            console.log(
                "[CobbleRealm] Version distante :",
                result.remoteVersion
            );

            if (
                result.updateAvailable
            ) {

                sendLauncherUpdateStatus(
                    "downloading",
                    "TÉLÉCHARGEMENT..."
                );

                console.log(
                    "[CobbleRealm] Mise à jour du modpack en cours..."
                );

                const zipPaths =
    await downloadLatestCobbleRealmPack(
        result.manifest
    );

console.log(
    "[CobbleRealm] ZIP téléchargés :",
    zipPaths
);

sendLauncherUpdateStatus(
    "installing",
    "INSTALLATION..."
);

await extractCobbleRealmPack(
    zipPaths
);

writeLocalCobbleRealmVersion(
    result.remoteVersion
);

console.log(
    "[CobbleRealm] Pack installé avec succès."
);
            }

            sendLauncherUpdateStatus(
                "ready",
                "JOUER"
            );

        } catch (error) {

            console.error(
                "[CobbleRealm] Erreur mise à jour :",
                error
            );

            sendLauncherUpdateStatus(
                "error",
                "ERREUR DE MISE À JOUR"
            );
        }
    }
);


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


app.on(
    "activate",
    () => {

        if (
            BrowserWindow.getAllWindows().length === 0
        ) {

            createMainWindow();
        }
    }
);
