import { genericOAuth, organization } from "better-auth/plugins";

export const organizationPlugin = () =>
  organization({
    allowUserToCreateOrganization: false,
    disableOrganizationDeletion: true,
    requireEmailVerificationOnInvitation: true,
    organizationHooks: {
      beforeUpdateOrganization: async ({ organization: changes }) => {
        if (changes.slug !== undefined && !/^[a-z0-9-]{1,48}$/.test(changes.slug)) throw new Error("workspace addresses use lowercase letters, digits and dashes, up to 48 characters");
        if (changes.name !== undefined && (changes.name.trim().length === 0 || changes.name.length > 100)) throw new Error("workspace names are 1 to 100 characters");
      },
    },
  });

export const devSignIn = (devOidc?: { issuer: string; clientId: string; clientSecret: string }) =>
  devOidc
    ? [genericOAuth({ config: [{ providerId: "dev", clientId: devOidc.clientId, clientSecret: devOidc.clientSecret, discoveryUrl: `${devOidc.issuer}/.well-known/openid-configuration`, scopes: ["openid", "email", "profile"], disableProviderLogout: true }] })]
    : [];
