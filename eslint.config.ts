import globals from "globals";
import pluginJs from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import tseslint from "typescript-eslint";

export default tseslint.config(
	pluginJs.configs.recommended,
	...tseslint.configs.recommended,
	{
		plugins: {
			jsdoc,
		},
		files: ["**/*.ts"],
		languageOptions: {
			sourceType: "module",
			globals: {
				...globals.node,
			},
		},
		rules: {
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": "warn",
			"@typescript-eslint/no-explicit-any": "warn",
			"jsdoc/require-param-type": "off",
			"jsdoc/require-returns-type": "off",
			"jsdoc/check-types": "error",
			"jsdoc/no-undefined-types": "error",
			"jsdoc/valid-types": "error",
			"jsdoc/check-param-names": "error",
			"jsdoc/require-param": "off",
			"jsdoc/require-returns": "off",
		},
	},
	{
		ignores: ["node_modules/", "dist/", "package-lock.json"],
	},
);
