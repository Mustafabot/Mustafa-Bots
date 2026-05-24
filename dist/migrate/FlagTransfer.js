import Parser from 'wikiparser-node';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createZhApi, createCmApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { withApiRetry, checkModerationQueued, checkModerationQueuedError } from '../utils/retry.js';
Parser.config = 'moegirl';
const MAX_RETRIES = 3;
const DEFAULT_COMMENT = '机器人：自维基共享搬运国旗文件';
const WMF_API = 'https://commons.wikimedia.org/w/api.php';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FLAGICON_PATH = resolve(__dirname, '../../data/flagicon.wikitext');
const COMPLETED_FILE = resolve(__dirname, '../../data/flag_transfer_completed.json');
const TEMP_DIR = resolve(__dirname, '../../temp');
// ============================================================
// Task 1 & 3: flagicon 映射解析 & 本地完成记录管理
// ============================================================
/**
 * 将 map 中的值解析为完整文件名。
 * - 如果值本身就是完整文件名（含扩展名或 File: 前缀），直接使用
 * - 否则视为 Flag_of_{suffix}.svg 中的 suffix 部分
 */
function resolveFilename(suffix) {
    // 已经是完整文件路径
    if (suffix.startsWith('File:'))
        return suffix;
    if (/\.\w+$/.test(suffix))
        return `File:${suffix}`;
    return `File:Flag_of_${suffix}.svg`;
}
function buildFlagMap() {
    const content = readFileSync(FLAGICON_PATH, 'utf-8');
    const map = new Map();
    // 逐行匹配 |中文名列表 = EnglishSuffix 模式
    const lines = content.split('\n');
    for (const line of lines) {
        // 匹配: |名1|名2|... = Suffix，可选尾随 <!-- ... -->
        const match = line.match(/^\s*\|(.+?)\s*=\s*(.+?)(?:\s*<!--.*)?\r?$/);
        if (!match)
            continue;
        const leftPart = match[1].trim();
        const rightPart = match[2].trim();
        // 跳过 {{{1|China}}} 这类默认值行
        if (leftPart.includes('{{{'))
            continue;
        // 跳过值为 None 的条目
        if (rightPart === 'None')
            continue;
        // leftPart 可能包含多个中文名，用 | 分隔
        const names = leftPart.split('|').map(s => s.trim()).filter(Boolean);
        for (const name of names) {
            map.set(name, rightPart);
        }
    }
    console.log(`解析 flagicon 模板得到 ${map.size} 个映射`);
    return map;
}
function loadCompleted() {
    try {
        if (existsSync(COMPLETED_FILE)) {
            const data = JSON.parse(readFileSync(COMPLETED_FILE, 'utf-8'));
            return new Set(data.completed);
        }
    }
    catch (error) {
        console.error('读取完成记录失败:', error);
    }
    return new Set();
}
function saveCompleted(completed) {
    try {
        const dir = dirname(COMPLETED_FILE);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        const data = {
            completed: [...completed].sort(),
            lastUpdate: new Date().toISOString(),
        };
        writeFileSync(COMPLETED_FILE, JSON.stringify(data, null, 2), 'utf-8');
    }
    catch (error) {
        console.error('保存完成记录失败:', error);
    }
}
// ============================================================
// Task 2: 查找 flagicon 模板使用情况
// ============================================================
async function findFlagiconUsages(api) {
    const usedParams = new Set();
    const eol = Symbol();
    let eicontinue;
    console.log('\n正在查找 {{flagicon}} 模板使用情况...');
    while (eicontinue !== eol) {
        const { data } = await api.post({
            action: 'query',
            list: 'embeddedin',
            eititle: 'Template:flagicon',
            einamespace: '0',
            eilimit: 50,
            eicontinue: eicontinue,
        });
        const pages = data.query.embeddedin;
        const titles = pages.map((p) => p.title);
        // 批量获取页面内容，每次 50 个
        for (let i = 0; i < titles.length; i += 50) {
            const batch = titles.slice(i, i + 50);
            const contentData = await api.post({
                action: 'query',
                prop: 'revisions',
                rvprop: 'content',
                titles: batch.join('|'),
            });
            const pagesObj = contentData.data.query.pages;
            for (const pageId of Object.keys(pagesObj)) {
                const page = pagesObj[pageId];
                if (!page.revisions)
                    continue;
                const wikitext = page.revisions[0].content;
                const parsed = Parser.parse(wikitext, page.title);
                const templates = parsed.querySelectorAll('template');
                for (const tpl of templates) {
                    const name = (tpl.name || '').replace(/^Template:/i, '').toLowerCase().replace(/_/g, ' ');
                    if (name === 'flagicon') {
                        const param1 = tpl.getValue('1');
                        if (param1 && param1.trim()) {
                            usedParams.add(param1.trim());
                        }
                    }
                }
            }
        }
        eicontinue = data.continue?.eicontinue ?? eol;
        if (eicontinue !== eol) {
            console.log(`  已处理 ${usedParams.size} 个不同参数，继续...`);
        }
    }
    console.log(`共找到 ${usedParams.size} 个不同的 flagicon 参数1`);
    return usedParams;
}
// ============================================================
// Task 4: 维基共享文件获取（双重回退）
// ============================================================
async function fetchCommonsDirectUrl(suffix) {
    const filename = resolveFilename(suffix);
    const url = `${WMF_API}?action=query&prop=imageinfo&iiprop=url&titles=${encodeURIComponent(filename)}&format=json`;
    const response = await fetch(url, {
        headers: { 'User-Agent': config.userAgent },
    });
    if (!response.ok) {
        throw new Error(`WMF API 返回 HTTP ${response.status}`);
    }
    const data = await response.json();
    const pages = data.query?.pages;
    if (!pages)
        throw new Error('WMF API 响应无 pages');
    const page = Object.values(pages)[0];
    if (!page || page.missing) {
        throw new Error(`文件 ${filename} 在维基共享不存在`);
    }
    const imageinfo = page.imageinfo;
    if (!imageinfo || !imageinfo[0]?.url) {
        throw new Error(`文件 ${filename} 无 imageinfo`);
    }
    return imageinfo[0].url;
}
function fetchCommonsFallbackUrl(suffix) {
    const filename = resolveFilename(suffix);
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename.replace(/^File:/i, ''))}`;
}
async function getCommonsFileUrl(suffix) {
    try {
        const url = await fetchCommonsDirectUrl(suffix);
        console.log(`  获取直链成功 (API): ${url}`);
        return url;
    }
    catch (error) {
        console.log(`  WMF API 失败: ${error.message}，回退 Special:FilePath`);
        const url = fetchCommonsFallbackUrl(suffix);
        console.log(`  使用 Special:FilePath: ${url}`);
        return url;
    }
}
// ============================================================
// Task 5: 萌娘共享文件存在检查 & 上传（双重回退）
// ============================================================
/**
 * 检查文件是否已存在于萌娘共享站
 */
async function checkFileExistsOnCm(api, filename) {
    try {
        const { data } = await api.post({
            action: 'query',
            prop: 'imageinfo',
            titles: filename,
        });
        const pages = data.query?.pages;
        if (!pages)
            return false;
        const page = Object.values(pages)[0];
        // page.missing 或 page.imagerepository === '' 表示文件不存在
        if (page?.missing)
            return false;
        // 检查是否有 imageinfo（有则文件存在且可访问）
        if (page?.imageinfo && page.imageinfo.length > 0) {
            return true;
        }
        return false;
    }
    catch (error) {
        // 查询失败时不阻断流程，返回 false 让后续上传尝试处理
        console.error(`  检查文件存在性失败: ${error}`);
        return false;
    }
}
function ensureTempDir() {
    if (!existsSync(TEMP_DIR)) {
        mkdirSync(TEMP_DIR, { recursive: true });
    }
}
function cleanupTempFile(filePath) {
    try {
        if (existsSync(filePath)) {
            unlinkSync(filePath);
        }
    }
    catch (error) {
        console.error(`  清理临时文件失败: ${filePath}`, error);
    }
}
async function downloadImage(url, filePath) {
    const response = await fetch(url, {
        headers: { 'User-Agent': config.userAgent },
    });
    if (!response.ok) {
        throw new Error(`下载失败: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(filePath, buffer);
    const contentType = response.headers.get('content-type');
    return contentType ? contentType.split(';')[0].trim().toLowerCase() : 'image/svg+xml';
}
async function uploadFromFile(api, filePath, filename, mimeType) {
    const fileBuffer = readFileSync(filePath);
    const file = new File([fileBuffer], filename.replace(/^File:/i, ''), { type: mimeType });
    return withApiRetry(() => api.postWithToken('csrf', {
        action: 'upload',
        filename,
        file,
        comment: DEFAULT_COMMENT,
        text: '{{PD-Other}}[[Category:旗帜]][[Category:从维基共享批量转移的文件]]',
        ignorewarnings: true,
        bot: true,
        tags: 'Bot',
        watchlist: 'nochange',
    }, {
        retry: 500,
        noCache: true,
    }), {
        maxRetries: MAX_RETRIES,
        baseDelay: 1000,
        onSuccess: (data) => {
            if (data.upload?.result === 'Success' || checkModerationQueued(data)) {
                return true;
            }
            return null;
        },
        onError: (error) => {
            if (checkModerationQueuedError(error)) {
                throw error;
            }
            console.log(`  本地上传失败: ${error.message}`);
        },
        shouldRetry: () => true,
    });
}
async function uploadToCm(api, sourceUrl, filename, dryRun) {
    if (dryRun) {
        console.log(`  [试运行] 将上传: ${filename} (来源: ${sourceUrl})`);
        return true;
    }
    // 策略1: URL 上传
    try {
        return await withApiRetry(() => api.postWithToken('csrf', {
            action: 'upload',
            filename,
            url: sourceUrl,
            comment: DEFAULT_COMMENT,
            text: '{{Copyright}}[[Category:旗帜]][[Category:迁移文件]]',
            ignorewarnings: true,
            bot: true,
            tags: 'Bot',
            watchlist: 'nochange',
        }, {
            retry: 500,
            noCache: true,
        }), {
            maxRetries: MAX_RETRIES,
            baseDelay: 1000,
            onSuccess: (data) => {
                if (data.upload?.result === 'Success' || checkModerationQueued(data)) {
                    return true;
                }
                return null;
            },
            onError: (error) => {
                if (checkModerationQueuedError(error)) {
                    throw error;
                }
                console.log(`  URL上传失败: ${error.message}`);
            },
            shouldRetry: () => true,
        });
    }
    catch (error) {
        if (checkModerationQueuedError(error)) {
            console.log('  文件已进入审核队列');
            return true;
        }
        console.log(`  URL上传失败，回退本地下载上传: ${error.message}`);
    }
    // 策略2: 本地下载后上传
    ensureTempDir();
    const safeName = filename.replace(/[<>:"/\\|?*]/g, '_');
    const tempPath = resolve(TEMP_DIR, `${Date.now()}_${safeName.replace(/^File:/i, '')}`);
    try {
        const mimeType = await downloadImage(sourceUrl, tempPath);
        const result = await uploadFromFile(api, tempPath, filename, mimeType);
        return result;
    }
    catch (downloadError) {
        console.error(`  本地下载上传也失败: ${downloadError.message}`);
        return false;
    }
    finally {
        cleanupTempFile(tempPath);
    }
}
// ============================================================
// Task 6: 主流程与 CLI
// ============================================================
function parseArgs(args) {
    const result = { dryRun: false, verbose: false, reset: false };
    for (const arg of args) {
        if (arg === '--dry-run')
            result.dryRun = true;
        else if (arg === '--verbose')
            result.verbose = true;
        else if (arg === '--reset')
            result.reset = true;
    }
    return result;
}
async function main() {
    console.log(`Start time: ${new Date().toISOString()}`);
    const args = parseArgs(process.argv.slice(2));
    if (args.dryRun)
        console.log('\n[试运行模式] 不会实际上传文件');
    if (args.verbose)
        console.log('[详细模式]');
    // 1. 构建映射
    const flagMap = buildFlagMap();
    // 2. 登录（只需要 zh 站登录来查 embeddedin，cm 站登录来上传）
    console.log('\n正在登录 zh 站...');
    await clientlogin(zhApi, config.zh.bot.clientUsername, config.zh.bot.clientPassword);
    console.log('正在登录 commons 站...');
    await clientlogin(cmApi, config.cm.bot.clientUsername, config.cm.bot.clientPassword, config.cm.api);
    // 3. 查找实际使用
    const usedParams = await findFlagiconUsages(zhApi);
    // 4. 加载已完成记录
    const completed = args.reset ? new Set() : loadCompleted();
    if (args.reset)
        console.log('已重置完成记录');
    // 5. 筛选待处理
    const pending = [];
    for (const name of usedParams) {
        const suffix = flagMap.get(name) || name;
        if (completed.has(suffix)) {
            if (args.verbose)
                console.log(`  跳过已完成: ${name} -> ${suffix}`);
            continue;
        }
        pending.push({ name, suffix });
    }
    console.log(`\n待搬运: ${pending.length} 个文件`);
    if (pending.length === 0) {
        console.log('无需处理，退出');
        return;
    }
    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < pending.length; i++) {
        const { name, suffix } = pending[i];
        const filename = resolveFilename(suffix);
        console.log(`\n[${i + 1}/${pending.length}] ${name} -> ${filename}`);
        // 检查萌娘共享是否已存在同名文件
        if (!args.dryRun) {
            const exists = await checkFileExistsOnCm(cmApi, filename);
            if (exists) {
                console.log(`  萌娘共享已存在 ${filename}，跳过`);
                completed.add(suffix);
                saveCompleted(completed);
                continue;
            }
        }
        // 获取维基共享文件 URL
        let sourceUrl;
        try {
            sourceUrl = await getCommonsFileUrl(suffix);
        }
        catch (error) {
            console.error(`  获取源文件失败: ${error.message}`);
            failCount++;
            continue;
        }
        // 上传到萌娘共享
        const ok = await uploadToCm(cmApi, sourceUrl, filename, args.dryRun);
        if (ok) {
            successCount++;
            completed.add(suffix);
            saveCompleted(completed);
            console.log(`  完成: ${filename}`);
        }
        else {
            failCount++;
            console.error(`  失败: ${filename}`);
        }
    }
    console.log(`\n========== 完成 ==========`);
    console.log(`成功: ${successCount}`);
    console.log(`失败: ${failCount}`);
    console.log(`完成记录已保存至: ${COMPLETED_FILE}`);
    console.log(`End time: ${new Date().toISOString()}`);
}
const zhApi = createZhApi();
const cmApi = createCmApi();
(async () => {
    try {
        await main();
    }
    catch (error) {
        console.error('发生错误:', error);
        process.exit(1);
    }
})();
