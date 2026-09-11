#!/usr/bin/env node
// Builds one static Tailwind stylesheet per portal page, using that page's own
// inline `tailwind.config = {...}` block, so the output is pixel-identical to what the
// Play CDN produced. Output: frontend/assets/css/<page>.css
//
//   node scripts/build-tailwind.js          # build all
//   node scripts/build-tailwind.js login    # build one page
//
// Marketing pages (initial_*.html) are scraped WordPress output and do not use Tailwind.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const OUT_DIR = path.join(FRONTEND, 'assets', 'css');
const TMP_DIR = path.join(ROOT, '.tailwind-tmp');

const only = process.argv[2];
const pages = fs.readdirSync(FRONTEND)
    .filter((f) => f.endsWith('.html') && !f.startsWith('initial_'))
    .filter((f) => !only || f === `${only}.html`);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

function extractConfig(html, page) {
    const m = html.match(/<script id="tailwind-config">([\s\S]*?)<\/script>/);
    if (!m) return null;
    const sandbox = { tailwind: {} };
    vm.runInNewContext(m[1], sandbox, { filename: `${page}#tailwind-config` });
    return sandbox.tailwind.config;
}

let built = 0;
for (const page of pages) {
    const html = fs.readFileSync(path.join(FRONTEND, page), 'utf8');
    const config = extractConfig(html, page);
    if (!config) {
        console.log(`skip  ${page} (no inline tailwind config)`);
        continue;
    }
    const name = page.replace(/\.html$/, '');
    const configPath = path.join(TMP_DIR, `${name}.config.js`);
    const inputPath = path.join(TMP_DIR, `${name}.input.css`);
    const outPath = path.join(OUT_DIR, `${name}.css`);

    const full = {
        ...config,
        content: [path.join(FRONTEND, page).replace(/\\/g, '/')],
        plugins: ['require("@tailwindcss/forms")', 'require("@tailwindcss/container-queries")']
    };
    // plugins must be real requires, not strings
    const serialized = JSON.stringify(full, null, 2)
        .replace('"require(\\"@tailwindcss/forms\\")"', 'require("@tailwindcss/forms")')
        .replace('"require(\\"@tailwindcss/container-queries\\")"', 'require("@tailwindcss/container-queries")');
    fs.writeFileSync(configPath, `module.exports = ${serialized};\n`);
    fs.writeFileSync(inputPath, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');

    execFileSync(process.execPath, [
        path.join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
        '-c', configPath, '-i', inputPath, '-o', outPath, '--minify'
    ], { stdio: ['ignore', 'ignore', 'inherit'] });

    const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log(`built ${page} -> assets/css/${name}.css (${kb} KB)`);
    built++;
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });
console.log(`${built} stylesheet(s) built`);
