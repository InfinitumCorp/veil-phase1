// Runs the whole VEIL demo on this machine:
//   Cumulus://ID      http://localhost:8400
//   SCALVS.ai         http://localhost:8401
//   /CNDCTR/          http://localhost:8402
//   VEIL prototype    http://localhost:8410   <- open this
//
//   node veil-prototype/run-demo.mjs        (or: make demo)
//
// Development settings only: plain http on localhost, secrets generated
// into the demo data folder, and framing allowed for the prototype.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listen, persistentSecret } from "../infinitum-common/http.mjs";
import { createCumulusID } from "../cumulus-id/server.mjs";
import { createScalvs } from "../apps/scalvs/server.mjs";
import { createConductor } from "../apps/cndctr/server.mjs";
import { createPrototype } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = "https://infinitum-corporation.vercel.app/products";   // products without a local demo

export async function startDemo({ dataDir = path.join(HERE, ".demo-data"), ports = {}, host = "localhost", quiet = false } = {}) {
  const p = { cid: 8400, scalvs: 8401, cndctr: 8402, veil: 8410, ...ports };
  const url = k => `http://${host}:${p[k]}`;
  const secret = name => persistentSecret(path.join(dataDir, "secrets"), name);
  const scalvsSecret = secret("scalvs-client"), cndctrSecret = secret("cndctr-client"), serviceToken = secret("scalvs-service");

  const cid = createCumulusID({
    issuer: url("cid"), dataDir: path.join(dataDir, "cumulus-id"), frameAncestors: url("veil"),
    clients: [
      { client_id: "veil-browser", name: "VEIL", type: "public", redirect_uris: [`${url("veil")}/veil/callback`], allowed_origins: [url("veil")] },
      { client_id: "scalvs", name: "SCALVS.ai", type: "confidential", secret: scalvsSecret, redirect_uris: [`${url("scalvs")}/auth/callback`] },
      { client_id: "cndctr", name: "/CNDCTR/", type: "confidential", secret: cndctrSecret, redirect_uris: [`${url("cndctr")}/auth/callback`] },
    ],
  });
  const scalvs = createScalvs({ publicUrl: url("scalvs"), issuer: url("cid"), clientSecret: scalvsSecret,
    dataDir: path.join(dataDir, "scalvs"), frameAncestors: url("veil"), serviceToken });
  const cndctr = createConductor({ publicUrl: url("cndctr"), issuer: url("cid"), clientSecret: cndctrSecret,
    dataDir: path.join(dataDir, "cndctr"), frameAncestors: url("veil"), scalvsUrl: url("scalvs"), scalvsToken: serviceToken });

  // The dev app list: same shape as the signed registry, pointing at localhost.
  const registry = {
    schema: 1, version: 0,
    signin: { label: "Sign In", url: url("cid"), cid: {
      issuer: url("cid"), authorize_url: `${url("cid")}/authorize`, token_url: `${url("cid")}/token`,
      client_id: "veil-browser", redirect_uri: `${url("veil")}/veil/callback` } },
    apps: [
      { id: "cndctr", name: "/CNDCTR/™", summary: "AI coding & execution workspace", url: `${url("cndctr")}/`, panel: true },
      { id: "cumulus", name: "Cumulus://Cloud™", summary: "AI cloud, storage & data exchange", url: `${SITE}/cumulus-exchange` },
      { id: "mail", name: "Cumulus://Mail™", summary: "Email that comes with your cloud", url: `${SITE}/cumulus-exchange#mail` },
      { id: "fabric", name: "FABRIC™", summary: "Secure communications", url: `${SITE}/fabric` },
      { id: "firm", name: "FIRM Wallet™", summary: "Token, wallet & exchange", url: `${SITE}/firm#wallet` },
      { id: "metatron", name: "METATRON¹⁰⁰™", summary: "Consumer command suite", url: `${SITE}/metatron` },
      { id: "scalvs", name: "SCALVS.ai™", summary: "AI workforce platform", url: `${url("scalvs")}/`, panel: true },
    ],
    mail: { label: "Mail", url: `${SITE}/cumulus-exchange#mail` },
  };
  const veil = createPrototype({ registry, frameSources: [url("cid"), url("scalvs"), url("cndctr")] });

  await listen(cid.server, p.cid);
  await listen(scalvs.server, p.scalvs);
  await listen(cndctr.server, p.cndctr);
  await listen(veil, p.veil);
  if (!quiet) {
    console.log(`Cumulus://ID   ${url("cid")}`);
    console.log(`SCALVS.ai      ${url("scalvs")}${process.env.ANTHROPIC_API_KEY ? "" : "   (no model: set ANTHROPIC_API_KEY for real answers)"}`);
    console.log(`/CNDCTR/       ${url("cndctr")}`);
    console.log(`\nOpen VEIL:     ${url("veil")}\n`);
  }
  return {
    urls: { cid: url("cid"), scalvs: url("scalvs"), cndctr: url("cndctr"), veil: url("veil") },
    close: () => { cndctr.stop(); for (const s of [cid.server, scalvs.server, cndctr.server, veil]) s.close(); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDemo();
}
