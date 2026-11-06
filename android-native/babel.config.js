module.exports = function (api) {
  api.cache(true);
  const expoPackage = require.resolve("expo/package.json");
  const plugins = [];

  plugins.push(require.resolve("react-native-worklets/plugin"));

  return {
    presets: [
      [require.resolve("babel-preset-expo", { paths: [expoPackage] }), { jsxImportSource: "nativewind" }],
      require.resolve("nativewind/babel"),
    ],
    plugins,
  };
};
