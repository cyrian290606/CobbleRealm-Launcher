async function requestJson(
    url,
    options = {}
) {

    const response =
        await fetch(
            url,
            options
        );

    const text =
        await response.text();

    let data = null;

    try {

        data =
            text
                ? JSON.parse(text)
                : null;

    } catch {

        data = text;
    }


    if (!response.ok) {

        const error =
            new Error(
                `HTTP ${response.status} sur ${url}`
            );

        error.status =
            response.status;

        error.data =
            data;

        throw error;
    }


    return data;
}


/* ==============================
   MICROSOFT -> XBOX LIVE
============================== */

async function authenticateXbox(
    microsoftAccessToken
) {

    return await requestJson(
        "https://user.auth.xboxlive.com/user/authenticate",
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json",

                "Accept":
                    "application/json"
            },

            body: JSON.stringify({
                Properties: {
                    AuthMethod:
                        "RPS",

                    SiteName:
                        "user.auth.xboxlive.com",

                    RpsTicket:
                        `d=${microsoftAccessToken}`
                },

                RelyingParty:
                    "http://auth.xboxlive.com",

                TokenType:
                    "JWT"
            })
        }
    );
}


/* ==============================
   XBOX LIVE -> XSTS
============================== */

async function authenticateXSTS(
    xboxToken
) {

    return await requestJson(
        "https://xsts.auth.xboxlive.com/xsts/authorize",
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json",

                "Accept":
                    "application/json"
            },

            body: JSON.stringify({
                Properties: {
                    SandboxId:
                        "RETAIL",

                    UserTokens: [
                        xboxToken
                    ]
                },

                RelyingParty:
                    "rp://api.minecraftservices.com/",

                TokenType:
                    "JWT"
            })
        }
    );
}


/* ==============================
   XSTS -> MINECRAFT
============================== */

async function authenticateMinecraft(
    userHash,
    xstsToken
) {

    return await requestJson(
        "https://api.minecraftservices.com/authentication/login_with_xbox",
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json",

                "Accept":
                    "application/json"
            },

            body: JSON.stringify({
                identityToken:
                    `XBL3.0 x=${userHash};${xstsToken}`
            })
        }
    );
}


/* ==============================
   VÉRIFIER POSSESSION DU JEU
============================== */

async function getMinecraftEntitlements(
    minecraftAccessToken
) {

    return await requestJson(
        "https://api.minecraftservices.com/entitlements/mcstore",
        {
            method: "GET",

            headers: {
                "Authorization":
                    `Bearer ${minecraftAccessToken}`,

                "Accept":
                    "application/json"
            }
        }
    );
}


/* ==============================
   PROFIL MINECRAFT
============================== */

async function getMinecraftProfile(
    minecraftAccessToken
) {

    return await requestJson(
        "https://api.minecraftservices.com/minecraft/profile",
        {
            method: "GET",

            headers: {
                "Authorization":
                    `Bearer ${minecraftAccessToken}`,

                "Accept":
                    "application/json"
            }
        }
    );
}


/* ==============================
   CHAÎNE COMPLÈTE
============================== */

async function loginMinecraft(
    microsoftAccessToken,
    onLog = null
) {

    const log =
        (message) => {

            console.log(message);

            if (
                typeof onLog ===
                "function"
            ) {

                onLog(message);
            }
        };


    try {

        log(
            "[Minecraft] Authentification Xbox Live..."
        );


        const xbox =
            await authenticateXbox(
                microsoftAccessToken
            );


        if (
            !xbox ||
            !xbox.Token
        ) {

            throw new Error(
                "Xbox Live n'a pas retourné de token."
            );
        }


        log(
            "[Minecraft] Xbox Live OK"
        );


        log(
            "[Minecraft] Authentification XSTS..."
        );


        const xsts =
            await authenticateXSTS(
                xbox.Token
            );


        if (
            !xsts ||
            !xsts.Token
        ) {

            throw new Error(
                "XSTS n'a pas retourné de token."
            );
        }


        const userHash =
            xsts.DisplayClaims &&
            xsts.DisplayClaims.xui &&
            xsts.DisplayClaims.xui[0] &&
            xsts.DisplayClaims.xui[0].uhs;


        if (!userHash) {

            throw new Error(
                "Impossible de récupérer le UserHash Xbox."
            );
        }


        log(
            "[Minecraft] XSTS OK"
        );


        log(
            "[Minecraft] Connexion à Minecraft Services..."
        );


        const minecraft =
            await authenticateMinecraft(
                userHash,
                xsts.Token
            );


        if (
            !minecraft ||
            !minecraft.access_token
        ) {

            throw new Error(
                "Minecraft Services n'a pas retourné de token."
            );
        }


        log(
            "[Minecraft] Minecraft Services OK"
        );


        log(
            "[Minecraft] Vérification de la possession du jeu..."
        );


        const entitlements =
            await getMinecraftEntitlements(
                minecraft.access_token
            );


        const ownsMinecraft =
            Boolean(
                entitlements &&
                Array.isArray(
                    entitlements.items
                ) &&
                entitlements.items.length > 0
            );


        if (!ownsMinecraft) {

            log(
                "[Minecraft] Minecraft Java Edition non détecté sur ce compte."
            );

            return {
                success: false,

                error:
                    "Ce compte ne semble pas posséder Minecraft Java Edition."
            };
        }


        log(
            "[Minecraft] Minecraft Java Edition détecté."
        );


        log(
            "[Minecraft] Récupération du profil..."
        );


        const profile =
            await getMinecraftProfile(
                minecraft.access_token
            );


        log(
            `[Minecraft] Profil récupéré : ${
                profile
                    ? profile.name
                    : "inconnu"
            }`
        );


        return {
            success: true,

            accessToken:
                minecraft.access_token,

            profile: {
                id:
                    profile.id,

                name:
                    profile.name,

                skins:
                    profile.skins || [],

                capes:
                    profile.capes || []
            }
        };


    } catch (error) {

        console.error(
            "[Minecraft] Erreur :",
            error
        );


        let message =
            error.message ||
            "Erreur Minecraft inconnue.";


        if (
            error.status === 403 &&
            error.data &&
            typeof error.data === "object"
        ) {

            if (
                error.data.errorMessage
            ) {

                message =
                    error.data.errorMessage;
            }
        }


        if (
            typeof onLog ===
            "function"
        ) {

            onLog(
                `[Minecraft] Erreur : ${message}`
            );
        }


        return {
            success: false,

            status:
                error.status || null,

            error:
                message,

            details:
                error.data || null
        };
    }
}


module.exports = {
    loginMinecraft
};