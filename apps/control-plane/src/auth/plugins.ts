import { APIError } from "better-auth/api";
import { genericOAuth, organization } from "better-auth/plugins";

const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

export const WORKSPACE_NAME_RULE = "workspace names are 1 to 100 plain characters";

function refuse(message: string): never {
  throw new APIError("BAD_REQUEST", { code: "INVALID_WORKSPACE", message });
}

export const organizationPlugin = () =>
  organization({
    allowUserToCreateOrganization: false,
    disableOrganizationDeletion: true,
    requireEmailVerificationOnInvitation: true,
    organizationHooks: {
      beforeUpdateOrganization: async ({ organization: changes }) => {
        if (changes.slug !== undefined && !/^[a-z0-9-]{1,48}$/.test(changes.slug)) refuse("workspace addresses use lowercase letters, digits and dashes, up to 48 characters");
        if (changes.name !== undefined && (changes.name.trim().length === 0 || changes.name.length > 100 || INVISIBLE.test(changes.name))) refuse(WORKSPACE_NAME_RULE);
        if (changes.logo !== undefined && changes.logo !== null) {
          if (!(changes.logo.length <= 2048 && /^https:\/\//.test(changes.logo) && URL.canParse(changes.logo))) refuse("a workspace logo must be an https address");
          return { data: { ...changes, logo: new URL(changes.logo).href } };
        }
        if (changes.metadata !== undefined && JSON.stringify(changes.metadata ?? null).length > 4096) refuse("workspace metadata is limited to 4 KB");
      },
    },
  });

export const devSignIn = (devOidc?: { issuer: string; clientId: string; clientSecret: string }) =>
  devOidc
    ? [genericOAuth({ config: [{ providerId: "dev", clientId: devOidc.clientId, clientSecret: devOidc.clientSecret, discoveryUrl: `${devOidc.issuer}/.well-known/openid-configuration`, scopes: ["openid", "email", "profile"], disableProviderLogout: true }] })]
    : [];
