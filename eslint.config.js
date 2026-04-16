import globals from "globals";
import pluginJs from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";

export default [
  pluginJs.configs.recommended,
  {
    plugins: {
      jsdoc,
    },
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "jsdoc/require-param-type": "warn",
      "jsdoc/require-returns-type": "warn",
      "jsdoc/check-types": "error",
      "jsdoc/no-undefined-types": "error",
      "jsdoc/valid-types": "error",
      "jsdoc/check-param-names": "error",
      "jsdoc/require-param": "warn",
      "jsdoc/require-returns": "warn",
    },
  },
  {
    ignores: ["node_modules/", "package-lock.json"],
  },
];
