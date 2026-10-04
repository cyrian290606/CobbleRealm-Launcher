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

        // Supprime une éventuelle ancienne tentative
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


async function extractCobbleRealmPack(
    zipPaths
) {

    const gameRoot =
        getCobbleRealmRoot();

    if (!fs.existsSync(gameRoot)) {
        fs.mkdirSync(gameRoot, {
            recursive: true
        });
    }

    if (
        !Array.isArray(zipPaths) ||
        zipPaths.length === 0
    ) {
        throw new Error(
            "Aucune archive CobbleRealm à installer."
        );
    }

    console.log(
        `[CobbleRealm] Vérification de ${zipPaths.length} archive(s)...`
    );

    // ==============================
    // TEST DE TOUTES LES ARCHIVES
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
    // SAUVEGARDE DES FICHIERS JOUEUR
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
                    "[CobbleRealm] Erreur sauvegarde fichier joueur :",
                    fileName,
                    error
                );
            }
        }
    }


    // ==============================
    // NETTOYAGE DE L'ANCIEN MODPACK
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
    // EXTRACTION DES PARTIES
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
    // RESTAURATION DES FICHIERS JOUEUR
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
                "[CobbleRealm] Erreur restauration fichier joueur :",
                fileName,
                error
            );
        }
    }


    // ==============================
    // SUPPRESSION DES MODS INCOMPATIBLES
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

            console.log(
                `[CobbleRealm] Suppression du mod incompatible : ${modFile}`
            );

            fs.rmSync(modPath, {
                force: true
            });
        }
    }


    // ==============================
    // NETTOYAGE DES ZIP TEMPORAIRES
    // ==============================

    for (const zipPath of zipPaths) {

        try {

            fs.rmSync(zipPath, {
                force: true
            });

        } catch (error) {

            console.warn(
                "[CobbleRealm] Impossible de supprimer le ZIP temporaire :",
                zipPath,
                error
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
                    version
            },
            null,
            2
        ),

        "utf8"
    );

    console.log(
        "[CobbleRealm] Version locale mise à jour :",
        version
    );
}


/* ==============================
   FABRIC LOADER
============================== */

function getFabricProfileDirectory() {

    return path.join(
        getCobbleRealmRoot(),
        "versions",
        FABRIC_PROFILE_ID
    );
}


function getFabricProfilePath() {

    return path.join(
        getFabricProfileDirectory(),
        `${FABRIC_PROFILE_ID}.json`
    );
}


function isFabricProfileValid() {

    try {

        const profilePath =
            getFabricProfilePath();

        if (
            !fs.existsSync(
                profilePath
            )
        ) {
            return false;
        }

        const profile =
            JSON.parse(
                fs.readFileSync(
                    profilePath,
                    "utf8"
                )
            );

        return (
            profile &&
            profile.id === FABRIC_PROFILE_ID &&
            profile.inheritsFrom === MINECRAFT_VERSION &&
            typeof profile.mainClass === "string" &&
            profile.mainClass.length > 0 &&
            Array.isArray(profile.libraries)
        );

    } catch (error) {

        console.error(
            "[CobbleRealm] Profil Fabric local invalide :",
            error
        );

        return false;
    }
}


async function ensureFabricProfile(
    onLog = null
) {

    const log =
        (message) => {

            console.log(
                message
            );

            if (
                typeof onLog === "function"
            ) {
                onLog(
                    message
                );
            }
        };


    if (
        isFabricProfileValid()
    ) {

        log(
            `[CobbleRealm] Fabric Loader ${FABRIC_LOADER_VERSION} déjà préparé.`
        );

        return FABRIC_PROFILE_ID;
    }


    log(
        `[CobbleRealm] Préparation de Fabric Loader ${FABRIC_LOADER_VERSION} pour Minecraft ${MINECRAFT_VERSION}...`
    );


    const response =
        await fetch(
            FABRIC_PROFILE_URL,
            {
                cache:
                    "no-store"
            }
        );


    if (
        !response.ok
    ) {

        throw new Error(
            `Impossible de récupérer le profil Fabric (${response.status}).`
        );
    }


    const profile =
        await response.json();


    if (
        !profile ||
        !profile.id ||
        !profile.mainClass ||
        !Array.isArray(
            profile.libraries
        )
    ) {

        throw new Error(
            "Le profil Fabric reçu est invalide."
        );
    }


    profile.id =
        FABRIC_PROFILE_ID;

    profile.inheritsFrom =
        MINECRAFT_VERSION;


    const profileDirectory =
        getFabricProfileDirectory();


    fs.mkdirSync(
        profileDirectory,
        {
            recursive:
                true
        }
    );


    fs.writeFileSync(
        getFabricProfilePath(),

        JSON.stringify(
            profile,
            null,
            2
        ),

        "utf8"
    );


    log(
        `[CobbleRealm] Fabric Loader ${FABRIC_LOADER_VERSION} préparé avec succès.`
    );


    return FABRIC_PROFILE_ID;
}


/* ==============================
   FENÊTRE PRINCIPALE
============================== */


function sendLauncherUpdateStatus(
    status,
    message
) {

    const windows =
        BrowserWindow.getAllWindows();

    for (const win of windows) {

        if (
            win &&
            !win.isDestroyed()
        ) {

            win.webContents.send(
                "launcher-update-status",
                {
                    status:
                        status,

                    message:
                        message
                }
            );
        }
    }
}


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

                webSecurity:
                    true
            }
        });


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

ipcMain.handle(
    "microsoft-login",

    async (event) => {

        const result =
            await loginMicrosoft(

                async (
                    deviceCode
                ) => {

                    event.sender.send(
                        "microsoft-device-code",
                        deviceCode
                    );

                    if (
                        deviceCode &&
                        deviceCode.verificationUri
                    ) {

                        await shell.openExternal(
                            deviceCode.verificationUri
                        );
                    }
                }
            );

        return result;
    }
);


/* ==============================
   SESSION MICROSOFT
============================== */

ipcMain.handle(
    "microsoft-session",

    async () => {

        return await
            getMicrosoftSession();
    }
);


/* ==============================
   DÉCONNEXION MICROSOFT
============================== */

ipcMain.handle(
    "microsoft-logout",

    async () => {

        return await
            logoutMicrosoft();
    }
);


/* ==============================
   TEST MINECRAFT SERVICES
============================== */

ipcMain.handle(
    "minecraft-test",

    async () => {

        try {

            const microsoftResult =
                await loginMicrosoft();

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
                            ? microsoftResult.error
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
                error
            );

            return {
                success: false,

                step:
                    "launcher",

                error:
                    error.message ||
                    "Erreur inconnue pendant le test Minecraft."
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
                ram: 8
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
            ram:
                Math.max(
                    2,

                    Math.min(
                        Number(
                            data.ram
                        ) || 8,
                        16
                    )
                )
        };

    } catch (error) {

        console.error(
            "[CobbleRealm] Erreur lecture paramètres :",
            error
        );

        return {
            ram: 8
        };
    }
}


ipcMain.handle(
    "get-launcher-settings",

    async () => {

        return readLauncherSettings();
    }
);


ipcMain.handle(
    "save-launcher-settings",

    async (
        event,
        settings = {}
    ) => {

        try {

            const ram =
                Math.max(
                    2,

                    Math.min(
                        Number(
                            settings.ram
                        ) || 8,
                        16
                    )
                );


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
                    error.message
            };
        }
    }
);


ipcMain.handle(
    "check-cobblerealm-update",

    async () => {

        try {

            const result =
                await checkCobbleRealmUpdate();

            return {
                success: true,

                localVersion:
                    result.localVersion,

                remoteVersion:
                    result.remoteVersion,

                updateAvailable:
                    result.updateAvailable
            };

        } catch (error) {

            console.error(
                "[CobbleRealm] Erreur vérification mise à jour :",
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
    "get-launcher-news",

    async () => {
        if (!launcherNewsCache) {
            launcherNewsCache = await fetchLauncherNews();
        }

        return launcherNewsCache;
    }
);


/* ==============================
   JAVA 21 COBBLEREALM
============================== */

const JAVA_21_URL =
    "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse";


function getCobbleRealmJavaPath() {

    return path.join(
        getCobbleRealmRoot(),
        "runtime",
        "java21",
        "bin",
        "java.exe"
    );
}


async function downloadJava21(
    url,
    destination,
    onProgress = null
) {

    console.log(
        "[CobbleRealm] Téléchargement de Java 21..."
    );

    const response =
        await fetch(
            url,
            {
                redirect: "follow"
            }
        );

    if (!response.ok) {

        throw new Error(
            `Impossible de télécharger Java 21 (${response.status}).`
        );
    }

    if (!response.body) {

        throw new Error(
            "Aucun contenu reçu pendant le téléchargement de Java 21."
        );
    }

    const totalBytes =
        Number(
            response.headers.get(
                "content-length"
            )
        ) || 0;

    const reader =
        response.body.getReader();

    const fileStream =
        fs.createWriteStream(
            destination
        );

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
                        error => {

                            if (error) {
                                reject(error);
                            } else {
                                resolve();
                            }
                        }
                    );
                }
            );

            downloadedBytes +=
                value.byteLength;

            if (totalBytes > 0) {

                const percent =
                    Math.floor(
                        downloadedBytes /
                        totalBytes *
                        100
                    );

                if (
                    percent !==
                    lastPercent
                ) {

                    lastPercent =
                        percent;

                    console.log(
                        `[CobbleRealm] Java 21 : ${percent}%`
                    );

                    if (
                        typeof onProgress ===
                        "function"
                    ) {

                        onProgress(
                            percent
                        );
                    }
                }
            }
        }

        await new Promise(
            (resolve, reject) => {

                fileStream.end(
                    error => {

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
        "[CobbleRealm] Java 21 téléchargé."
    );
}


async function ensureJava21(
    onStatus = null
) {

    const javaPath =
        getCobbleRealmJavaPath();

    /*
     * Java déjà installé par CobbleRealm
     */

    if (
        fs.existsSync(
            javaPath
        )
    ) {

        console.log(
            "[CobbleRealm] Java 21 CobbleRealm déjà installé :",
            javaPath
        );

        return javaPath;
    }


    console.log(
        "[CobbleRealm] Java 21 CobbleRealm absent."
    );


    if (
        typeof onStatus ===
        "function"
    ) {

        onStatus(
            "Installation de Java 21..."
        );
    }


    const runtimeRoot =
        path.join(
            getCobbleRealmRoot(),
            "runtime"
        );

    const javaDirectory =
        path.join(
            runtimeRoot,
            "java21"
        );

    const tempDirectory =
        path.join(
            runtimeRoot,
            "java21-temp"
        );

    const zipPath =
        path.join(
            runtimeRoot,
            "java21.zip"
        );


    fs.mkdirSync(
        runtimeRoot,
        {
            recursive: true
        }
    );


    /*
     * Nettoyage ancienne tentative
     */

    fs.rmSync(
        tempDirectory,
        {
            recursive: true,
            force: true
        }
    );

    fs.rmSync(
        zipPath,
        {
            force: true
        }
    );


    /*
     * Téléchargement
     */

    await downloadJava21(
        JAVA_21_URL,
        zipPath,
        percent => {

            if (
                typeof onStatus ===
                "function"
            ) {

                onStatus(
                    `Téléchargement de Java 21... ${percent}%`
                );
            }
        }
    );


    /*
     * Extraction
     */

    if (
        typeof onStatus ===
        "function"
    ) {

        onStatus(
            "Installation de Java 21..."
        );
    }


    fs.mkdirSync(
        tempDirectory,
        {
            recursive: true
        }
    );


    await extract(
        zipPath,
        {
            dir:
                tempDirectory
        }
    );


    /*
     * Le ZIP Adoptium contient un dossier racine
     * dont le nom dépend de la version.
     */

    const entries =
        fs.readdirSync(
            tempDirectory,
            {
                withFileTypes: true
            }
        );

    const javaFolder =
        entries.find(
            entry =>
                entry.isDirectory()
        );


    if (!javaFolder) {

        throw new Error(
            "Impossible de trouver Java 21 dans l'archive téléchargée."
        );
    }


    const extractedJava =
        path.join(
            tempDirectory,
            javaFolder.name
        );


    /*
     * Remplacement du runtime
     */

    fs.rmSync(
        javaDirectory,
        {
            recursive: true,
            force: true
        }
    );


    fs.renameSync(
        extractedJava,
        javaDirectory
    );


    /*
     * Nettoyage
     */

    fs.rmSync(
        tempDirectory,
        {
            recursive: true,
            force: true
        }
    );

    fs.rmSync(
        zipPath,
        {
            force: true
        }
    );


    /*
     * Vérification finale
     */

    if (
        !fs.existsSync(
            javaPath
        )
    ) {

        throw new Error(
            "Java 21 a été téléchargé mais java.exe est introuvable."
        );
    }


    console.log(
        "[CobbleRealm] Java 21 installé avec succès :",
        javaPath
    );


    return javaPath;
}


/* ==============================
   LANCEMENT MINECRAFT
============================== */

ipcMain.handle(
    "launch-minecraft",

    async (
        event,
        launchOptions = {}
    ) => {

        try {

            console.log(
                "[TEST RAM] Valeur reçue du launcher :",
                launchOptions.ram,
                "Go"
            );


            console.log(
                "[CobbleRealm] Préparation du lancement..."
            );


            /*
             * 1) TOKEN MICROSOFT
             */

            const microsoftResult =
                await loginMicrosoft();


            if (
                !microsoftResult ||
                !microsoftResult.success ||
                !microsoftResult.accessToken
            ) {

                throw new Error(
                    "Impossible de récupérer la session Microsoft."
                );
            }


            /*
             * 2) TOKEN MINECRAFT
             */

            const minecraftResult =
                await loginMinecraft(

                    microsoftResult.accessToken,

                    (
                        message
                    ) => {

                        event.sender.send(
                            "minecraft-log",
                            message
                        );
                    }
                );


            if (
                !minecraftResult ||
                !minecraftResult.success
            ) {

                return {
                    success:
                        false,

                    step:
                        "minecraft-auth",

                    error:
                        minecraftResult &&
                        minecraftResult.error
                            ? minecraftResult.error
                            : "Impossible de se connecter à Minecraft Services.",

                    status:
                        minecraftResult
                            ? minecraftResult.status
                            : null
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


            /*
             * 3) DOSSIER COBBLEREALM
             */

            const gameRoot =
                getCobbleRealmRoot();

const javaPath =
    await ensureJava21(
        message => {

            event.sender.send(
                "minecraft-status",
                {
                    type:
                        "status",

                    message:
                        message
                }
            );
        }
    );


console.log(
    "[CobbleRealm] Java utilisé :",
    javaPath
);


            console.log(
                "[CobbleRealm] Dossier Minecraft :",
                gameRoot
            );


            event.sender.send(
                "minecraft-status",
                {
                    type:
                        "status",

                    message:
                        "Préparation de Minecraft..."
                }
            );

/*
 * 4) FABRIC LOADER
 */

event.sender.send(
    "minecraft-status",
    {
        type:
            "status",

        message:
            `Préparation de Fabric ${FABRIC_LOADER_VERSION}...`
    }
);


const fabricProfileId =
    await ensureFabricProfile(
        (
            message
        ) => {

            event.sender.send(
                "minecraft-log",
                message
            );
        }
    );


            /*
             * 4) OPTIONS DE LANCEMENT
             */

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
        MINECRAFT_VERSION,

    type:
        "release",

    custom:
        fabricProfileId
},

memory: {

                    max:
                        `${Math.max(
                            2,
                            Math.min(
                                Number(
                                    launchOptions.ram
                                ) || 8,
                                16
                            )
                        )}G`,

                    min:
                        "2G"
                }
            };


            console.log(
                "[CobbleRealm] RAM reçue :",
                launchOptions.ram,
                "Go"
            );


            console.log(
                "[CobbleRealm] RAM envoyée à Minecraft :",
                options.memory.max
            );


            /*
             * 5) ÉVÉNEMENTS
             */

            const debugListener =
                (
                    data
                ) => {

                    const message =
                        String(
                            data
                        );

                    console.log(
                        "[Minecraft DEBUG]",
                        message
                    );

                    event.sender.send(
                        "minecraft-log",
                        message
                    );
                };


            const dataListener =
                (
                    data
                ) => {

                    const message =
                        String(
                            data
                        );

                    console.log(
                        "[Minecraft]",
                        message
                    );

                    event.sender.send(
                        "minecraft-log",
                        message
                    );
                };


            const progressListener =
                (
                    progress
                ) => {

                    event.sender.send(
                        "minecraft-progress",
                        progress
                    );
                };


            launcher.on(
                "debug",
                debugListener
            );


            launcher.on(
                "data",
                dataListener
            );


            launcher.on(
                "progress",
                progressListener
            );

const closeListener =
    (code) => {

        console.log(
            "[CobbleRealm] Minecraft fermé. Code :",
            code
        );

        event.sender.send(
            "minecraft-status",
            {
                type: "closed",
                message: "Minecraft fermé."
            }
        );

        launcher.removeListener(
            "close",
            closeListener
        );
    };

launcher.on(
    "close",
    closeListener
);


            /*
             * 6) LANCEMENT
             */

            event.sender.send(
                "minecraft-status",
                {
                    type:
                        "status",

                    message:
                        "Lancement de Minecraft..."
                }
            );


            await launcher.launch(
                options
            );


            event.sender.send(
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
                error
            );


            event.sender.send(
                "minecraft-status",
                {
                    type:
                        "error",

                    message:
                        error.message ||
                        "Erreur de lancement."
                }
            );


            return {
                success:
                    false,

                step:
                    "launch",

                error:
                    error.message ||
                    "Erreur inconnue pendant le lancement."
            };
        }
    }
);


/* ==============================
   BOUTON DISCORD
============================== */

ipcMain.handle(
    "open-discord",

    async () => {

        try {

            await shell.openExternal(
                "https://discord.gg/CyA4Qc9NAC"
            );

            return {
                success: true
            };

        } catch (error) {

            return {
                success: false,
                error:
                    error.message
            };
        }
    }
);


/* ==============================
   BOUTON SITE
============================== */

ipcMain.handle(
    "open-site",

    async () => {

        try {

            await shell.openExternal(
                "https://cobblerealm.gitbook.io/cobblerealm-docs"
            );

            return {
                success: true
            };

        } catch (error) {

            return {
                success: false,
                error:
                    error.message
            };
        }
    }
);


/* ==============================
   BOUTON BOUTIQUE
============================== */

ipcMain.handle(
    "open-shop",

    async () => {

        try {

            await shell.openExternal(
                "https://cobblerealm-beta.tebex.store/"
            );

            return {
                success: true
            };

        } catch (error) {

            return {
                success: false,
                error:
                    error.message
            };
        }
    }
);


/* ==============================
   ELECTRON
============================== */

app.whenReady().then(
    async () => {

        /*
         * OUVERTURE IMMÉDIATE DU LAUNCHER
         */

        createWindow();

        /*
         * On attend que la fenêtre soit prête
         * avant d'envoyer les états de mise à jour.
         */

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


        try {

            launcherNewsCache = await fetchLauncherNews();

            /*
             * VÉRIFICATION
             */

            sendLauncherUpdateStatus(
                "checking",
                "VÉRIFICATION..."
            );

            console.log(
                "[CobbleRealm] Vérification des mises à jour..."
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

            console.log(
                "[CobbleRealm] Mise à jour disponible :",
                result.updateAvailable
            );


            if (
                result.updateAvailable
            ) {

                /*
                 * TÉLÉCHARGEMENT
                 */

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

/*
 * INSTALLATION
 */

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


            /*
             * PRÊT À JOUER
             */

            sendLauncherUpdateStatus(
                "ready",
                "JOUER"
            );


            console.log(
                "[CobbleRealm] Préparation terminée."
            );


        } catch (error) {

            console.error(
                "[CobbleRealm] Erreur pendant la mise à jour :",
                error
            );


            /*
             * EN CAS D'ERREUR :
             * JOUER RESTE BLOQUÉ
             */

            sendLauncherUpdateStatus(
                "error",
                "ERREUR DE MISE À JOUR"
            );
        }


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
