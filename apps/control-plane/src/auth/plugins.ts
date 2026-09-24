import { genericOAuth, organization } from "better-auth/plugins";

export const authPlugins = (devOidc?: { issuer: string; clientId: string; clientSecret: string }) => [
  organization(),
  ...(devOidc
    ? [genericOAuth({ config: [{ providerId: "dev", clientId: devOidc.clientId, clientSecret: devOidc.clientSecret, discoveryUrl: `${devOidc.issuer}/.well-known/openid-configuration`, scopes: ["openid", "email", "profile"] }] })]
    : []),
];
