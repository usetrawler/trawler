export const webLink = (url: string | null | undefined) => (url && /^https?:\/\//i.test(url) ? url : null);
