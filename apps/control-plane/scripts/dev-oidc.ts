import { OAuth2Server } from "oauth2-mock-server";

const port = Number(process.env.TRAWLER_DEV_OIDC_PORT ?? 4500);
const email = process.env.TRAWLER_DEV_EMAIL ?? "developer@trawler.local";
const server = new OAuth2Server();
await server.issuer.keys.generate("RS256");
const profile = { sub: email, email, email_verified: true, name: email.split("@")[0] };
server.service.on("beforeTokenSigning", (token) => Object.assign(token.payload, profile, { aud: "trawler-dev" }));
server.service.on("beforeUserinfo", (response) => {
  response.body = profile;
});
await server.start(port, "localhost");
console.log(`development OIDC issuer at ${server.issuer.url} signs everyone in as ${email}`);
