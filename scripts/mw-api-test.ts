#!/usr/bin/env npx tsx
/**
 * MediaWiki API Test Tool
 * Sends requests to MediaWiki API and returns JSON responses.
 *
 * Usage:
 *   npx tsx scripts/mw-api-test.ts --action=query --list=recentchanges --rclimit=5
 *   npx tsx scripts/mw-api-test.ts --action=query --list=allpages --aplimit=3 --login
 *   npx tsx scripts/mw-api-test.ts --action=parse --page=首页 --prop=sections --login --path=parse.sections
 *   npx tsx scripts/mw-api-test.ts --action=query --meta=siteinfo --siprop=namespaces --wiki=cm
 *   npx tsx scripts/mw-api-test.ts --action=query --list=recentchanges --rclimit=max --continue=3 --login
 *   npx tsx scripts/mw-api-test.ts --action=query --meta=siteinfo --no-auth
 */

import { MediaWikiApi } from 'wiki-saikou';
import config from '../src/config.js';
import clientlogin from '../src/clientlogin.js';

interface CliArgs {
  params: Record<string, string | number>;
  wiki: 'zh' | 'cm';
  path: string;
  raw: boolean;
  noAuth: boolean;
  doLogin: boolean;
  continueLimit: number;
}

function parseArgs(argv: string[]): CliArgs {
  const params: Record<string, string | number> = {};
  let wiki: 'zh' | 'cm' = 'zh';
  let path = '';
  let raw = false;
  let noAuth = false;
  let doLogin = false;
  let continueLimit = 0;

  for (const arg of argv) {
    if (arg === '--raw') {
      raw = true;
    } else if (arg === '--login') {
      doLogin = true;
    } else if (arg === '--no-auth') {
      noAuth = true;
    } else if (arg.startsWith('--wiki=')) {
      wiki = arg.split('=')[1] as 'zh' | 'cm';
    } else if (arg.startsWith('--path=')) {
      path = arg.slice(7);
    } else if (arg.startsWith('--continue=')) {
      continueLimit = Number(arg.split('=')[1]) || 5;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const eqIdx = arg.indexOf('=');
      const key = arg.slice(2, eqIdx);
      const value = arg.slice(eqIdx + 1);
      if (value === 'max') {
        params[key] = 'max';
      } else if (/^\d+$/.test(value)) {
        params[key] = Number(value);
      } else {
        params[key] = value;
      }
    } else if (arg.startsWith('--')) {
      params[arg.slice(2)] = true;
    }
  }

  return { params, wiki, path, raw, noAuth, doLogin, continueLimit };
}

function extractByPath(obj: unknown, path: string): { value: unknown; found: boolean } {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return { value: undefined, found: false };
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else if (typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return { value: undefined, found: false };
    }
  }
  return { value: current, found: true };
}

function formatOutput(data: unknown, raw: boolean): string {
  return raw ? JSON.stringify(data) : JSON.stringify(data, null, 2);
}

const { params, wiki, path, raw, noAuth, doLogin, continueLimit } = parseArgs(process.argv.slice(2));

if (!params.action) {
  console.error('Usage: npx tsx scripts/mw-api-test.ts --action=<action> [options] [--key=value...]');
  console.error('');
  console.error('Required:');
  console.error('  --action=ACTION         MediaWiki API action (e.g. query, parse, patrol)');
  console.error('');
  console.error('Options:');
  console.error('  --wiki=zh|cm            Target wiki (default: zh)');
  console.error('  --login                 Perform clientlogin before making the request');
  console.error('  --no-auth               Make request without any authentication (public API)');
  console.error('  --path=PATH             Extract nested field (e.g. query.pages)');
  console.error('  --continue=N            Follow continuation up to N pages (default: 0)');
  console.error('  --raw                   Output minified JSON');
  console.error('');
  console.error('All other --key=value pairs are passed as API parameters.');
  console.error('Numeric values are auto-converted; use "max" for max limits.');
  console.error('Use --login for actions that require authentication (allpages, parse, etc.)');
  console.error('Use --no-auth for public API testing (baseline debugging).');
  process.exit(1);
}

const wikiConfig = wiki === 'cm' ? config.cm : config.zh;

const api = new MediaWikiApi(wikiConfig.api, {
  headers: noAuth ? {} : { cookie: wikiConfig.cookie! },
});

try {
  if (doLogin) {
    await clientlogin(api, wikiConfig.bot.name!, wikiConfig.bot.password!);
  }

  if (continueLimit > 0) {
    const allResults: unknown[] = [];
    let continueParams: Record<string, string> | undefined;
    let pageCount = 0;

    while (pageCount < continueLimit) {
      const requestParams = { ...params, ...continueParams };
      const { data } = await api.post(requestParams, { noCache: true });

      let extracted = data;
      if (path) {
        const { value, found } = extractByPath(data, path);
        if (!found) {
          const keys = typeof data === 'object' && data !== null
            ? Object.keys(data as Record<string, unknown>).join(', ')
            : 'N/A';
          console.error(`Path "${path}" not found. Top-level keys: ${keys}`);
          process.exit(1);
        }
        extracted = value;
      }

      allResults.push(extracted);
      pageCount++;

      if (data.continue) {
        continueParams = data.continue;
      } else {
        break;
      }
    }

    if (allResults.length === 1) {
      console.log(formatOutput(allResults[0], raw));
    } else {
      console.log(formatOutput({ pages: allResults, total_pages: pageCount }, raw));
    }
  } else {
    const { data } = await api.post(params, { noCache: true });

    let result: unknown = data;
    if (path) {
      const { value, found } = extractByPath(data, path);
      if (!found) {
        const keys = typeof data === 'object' && data !== null
          ? Object.keys(data as Record<string, unknown>).join(', ')
          : 'N/A';
        console.error(`Path "${path}" not found. Top-level keys: ${keys}`);
        process.exit(1);
      }
      result = value;
    }

    console.log(formatOutput(result, raw));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`API request failed: ${message}`);
  process.exit(1);
}
