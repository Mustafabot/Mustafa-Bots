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
		files: ["src/gui/**/*.{ts,tsx}"],
		languageOptions: {
			globals: {
				...globals.browser,
			},
		},
	},
	{
		// 构建产物由 Vite 直接落到 src/server/public，压缩后的 bundle 不该被 lint
		ignores: ["node_modules/", "dist/", "package-lock.json", "src/gui/dist/", "src/server/public/"],
	},
);
