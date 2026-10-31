// As Lingui's Next example: the .po catalogs are compiled by @lingui/loader at build time.
export default {
  turbopack: { rules: { "*.po": { loaders: ["@lingui/loader"], as: "*.js" } } },
};
