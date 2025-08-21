// func.js
const fs = require("fs");
const common = require("oci-common");
const objectstorage = require("oci-objectstorage");
const { v4: uuid } = require("uuid");

/** 僅在 Fn/Functions 環境才載入 FDK */
function isFnEnv() {
    return Boolean(
        process.env.FN_LISTENER ||
        process.env.FN_FORMAT ||
        process.env.OCI_RESOURCE_PRINCIPAL_VERSION
    );
}

// ---- RP shim：把 Functions 注入的「檔案路徑」→ 轉成 SDK 也吃得下的「內容」 ----
function normalizeResourcePrincipalEnv() {
    try {
        // RP token：多數 SDK 讀 RPST（檔案路徑），少數版本也接受 RPT（內容）
        const rpst = process.env.OCI_RESOURCE_PRINCIPAL_RPST;
        if (rpst && fs.existsSync(rpst) && !process.env.OCI_RESOURCE_PRINCIPAL_RPT) {
            process.env.OCI_RESOURCE_PRINCIPAL_RPT = fs.readFileSync(rpst, "utf8").trim();
        }
        // Private key：Functions 通常把「檔案路徑」放在 PRIVATE_PEM；我們同時保留 PATH 與 內容
        let pemPath = process.env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM_PATH
            || process.env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM;
        if (pemPath && fs.existsSync(pemPath)) {
            process.env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM_PATH = pemPath;
            process.env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM = fs.readFileSync(pemPath, "utf8");
        }
    } catch (err) {
        console.error("Error normalizing RP env:", err);
    }
}
normalizeResourcePrincipalEnv();

// ---- Provider builders ----
async function buildResourcePrincipalProvider() {
    // 有些 SDK 版本 builder() 回 provider；有些回 Promise
    const RP = common.ResourcePrincipalAuthenticationDetailsProvider;
    const built = RP.builder();
    return (built && typeof built.then === "function") ? await built : built;
}

async function buildInstancePrincipalProvider() {
    // 常見是 builder().build()；保守處理不同實作
    const b = common.InstancePrincipalsAuthenticationDetailsProvider.builder();
    if (typeof b.build === "function") {
        const p = b.build();
        return (p && typeof p.then === "function") ? await p : p;
    }
    return (b && typeof b.then === "function") ? await b : b;
}

/** 取得認證提供者：OCI Functions → Instance Principals → 本機 ~/.oci/config */
async function getAuthProvider() {
    if (process.env.OCI_RESOURCE_PRINCIPAL_VERSION) {
        console.log("RP Env Check:", {
            version: !!process.env.OCI_RESOURCE_PRINCIPAL_VERSION,
            region: !!process.env.OCI_RESOURCE_PRINCIPAL_REGION,
            rpst: !!process.env.OCI_RESOURCE_PRINCIPAL_RPST,
            pem: !!process.env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM
        });
        return await buildResourcePrincipalProvider();
    }
    try {
        return await buildInstancePrincipalProvider();
    } catch (_) {
        // 落回本機開發：使用 ~/.oci/config（可用 OCI_CONFIG_FILE / OCI_PROFILE 覆蓋）
        const cfg = process.env.OCI_CONFIG_FILE;
        const prof = process.env.OCI_PROFILE;
        return new common.ConfigFileAuthenticationDetailsProvider(cfg, prof);
    }
}

/** 從 provider / 環境解出 region 字串 */
function resolveRegion(provider) {
    try {
        const r = provider.getRegion && provider.getRegion();
        if (r) return r.regionId || r.toString?.() || r;
    } catch { }
    return process.env.OCI_RESOURCE_PRINCIPAL_REGION || process.env.OCI_REGION || "ap-tokyo-1";
}

/** 設定 ObjectStorageClient 的區域（容錯） */
function setRegionSafe(client, regionId) {
    try { client.region = common.Region.fromRegionId(regionId); }
    catch { if (client.setRegion) client.setRegion(regionId); else client.regionId = regionId; }
}

/** RP 偵測（只回布林與檔案是否存在，不外洩內容） */
function rpEnvProbe() {
    const present = {
        OCI_RESOURCE_PRINCIPAL_VERSION: !!process.env.OCI_RESOURCE_PRINCIPAL_VERSION,
        OCI_RESOURCE_PRINCIPAL_REGION: !!process.env.OCI_RESOURCE_PRINCIPAL_REGION,
        OCI_RESOURCE_PRINCIPAL_RPST: !!process.env.OCI_RESOURCE_PRINCIPAL_RPST,
        OCI_RESOURCE_PRINCIPAL_RPT: !!process.env.OCI_RESOURCE_PRINCIPAL_RPT,
        OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM: !!process.env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM,
        OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM_PATH: !!process.env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM_PATH,
    };
    const files = {
        rpstOk: process.env.OCI_RESOURCE_PRINCIPAL_RPST
            ? fs.existsSync(process.env.OCI_RESOURCE_PRINCIPAL_RPST) : false,
        pemPathOk: process.env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM_PATH
            ? fs.existsSync(process.env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM_PATH) : false,
    };
    return { present, files };
}

/** 核心：建立 PAR（ObjectWrite） */
async function issuePar({ userId = "tester", appVersion = "0.0.0", env = "internal" }) {
    const provider = await getAuthProvider();
    const client = new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider });

    const region = resolveRegion(provider);
    setRegionSafe(client, region);

    const { value: namespaceName } = await client.getNamespace({});
    const BUCKET = process.env.BUCKET || "my-internal-logs";
    const TTL = parseInt(process.env.DEFAULT_TTL_SEC || "900", 10);

    const key = `logs/${env}/${appVersion}/${userId}/${Date.now()}-${uuid()}.zip`;

    const resp = await client.createPreauthenticatedRequest({
        namespaceName,
        bucketName: BUCKET,
        createPreauthenticatedRequestDetails: {
            name: `upload-${Date.now()}`,
            accessType: "ObjectWrite",
            objectName: key,
            timeExpires: new Date(Date.now() + TTL * 1000)
        }
    });

    const url = `https://objectstorage.${region}.oraclecloud.com${resp.preauthenticatedRequest.accessUri}`;
    return { url, key, expiresAt: new Date(Date.now() + TTL * 1000).toISOString() };
}

/** —— Functions 入口（加強錯誤輸出） —— */
if (isFnEnv()) {
    console.log("BOOT_MARKER: RP shim enabled");
    const fdk = require("@fnproject/fdk");
    fdk.handle(async (input, ctx) => {
        ctx.responseContentType = "application/json";
        try {
            if (input?.mode === "envdump") return rpEnvProbe();
            if (input?.mode === "selftest") {
                const provider = await getAuthProvider();
                const client = new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
                const region = resolveRegion(provider);
                setRegionSafe(client, region);
                const ns = await client.getNamespace({});
                const bucket = process.env.BUCKET || "my-internal-logs";
                const binfo = await client.getBucket({ namespaceName: ns.value, bucketName: bucket });
                return { ok: true, namespace: ns.value, bucket: binfo.bucket?.name || bucket, region, rp: rpEnvProbe() };
            }
            return await issuePar(input || {});
        } catch (e) {
            console.error("ISSUE_PAR_FAILED", e);
            ctx.httpGateway.statusCode = 500;
            return { error: "issue_par_failed", message: e?.message || String(e), rp: rpEnvProbe() };
        }
    }, { inputMode: "json" });
}

/** —— 本機 CLI 模式 —— */
if (require.main === module && !isFnEnv()) {
    (async () => {
        const args = process.argv.slice(2);
        const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] || d) : d; };
        try {
            const out = await issuePar({
                userId: arg("userId", "tester"),
                appVersion: arg("appVersion", "0.0.0"),
                env: arg("env", "internal")
            });
            console.log(JSON.stringify(out, null, 2));
        } catch (e) {
            console.error(e?.message || e);
            process.exit(1);
        }
    })();
}
