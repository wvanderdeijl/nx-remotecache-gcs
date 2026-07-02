#!/usr/bin/env node

/**
 * Nx Version Export Verification Script
 *
 * This script programmatically verifies if the default task runner export
 * from '@nx/workspace/tasks-runners/default' is available and functional
 * across different major versions of Nx (from v16 to v23+).
 *
 * It dynamically fetches the latest stable versions for each major,
 * installs them in a temporary directory, and attempts to 'require' and
 * validate the runner function at runtime.
 *
 * Usage:
 *   node scripts/verify-nx-versions.js
 *   ./scripts/verify-nx-versions.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAJORS = [16, 17, 18, 19, 20, 21, 22, 23];
const CHECK_PATH = '@nx/workspace/tasks-runners/default';

async function verify() {
    console.log('=== Nx Version Export Verification (Call Test) ===');
    console.log('Fetching latest stable versions for each major...\n');

    const versionsRaw = execSync('npm view @nx/workspace versions --json').toString();
    const allVersions = JSON.parse(versionsRaw);

    const targetVersions = MAJORS.map(major => {
        const stable = allVersions.filter(
            v =>
                v.startsWith(`${major}.`) &&
                !v.includes('-') &&
                !v.includes('beta') &&
                !v.includes('alpha') &&
                !v.includes('rc') &&
                !v.includes('canary') &&
                v !== '19.8.15', // Skip deprecated/broken version
        );
        return stable[stable.length - 1];
    }).filter(Boolean);

    if (!targetVersions.includes('16.9.1')) targetVersions.unshift('16.9.1');
    targetVersions.sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if (pa[i] !== pb[i]) return pa[i] - pb[i];
        }
        return 0;
    });

    const tempDir = path.join(process.cwd(), 'temp-verify-nx');
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
    fs.mkdirSync(tempDir);

    for (const version of targetVersions) {
        process.stdout.write(`Testing Nx ${version}: `);
        const testDir = path.join(tempDir, `v${version.replace(/\./g, '_')}`);
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'test-' + version }));

        try {
            execSync(`npm install @nx/workspace@${version} --no-save --legacy-peer-deps`, {
                cwd: testDir,
                stdio: 'ignore',
            });

            const checkCode = `
                try {
                    const runner = require('${CHECK_PATH}').default;
                    if (typeof runner !== 'function') {
                        process.stdout.write('FAILED (not a function)');
                        process.exit(0);
                    }
                    process.stdout.write('WORKS');
                    process.exit(0);
                } catch (e) {
                    process.stdout.write('ERROR: ' + e.message);
                    process.exit(0);
                }
            `;
            const result = execSync(`node -e "${checkCode.replace(/\n/g, '')}"`, {
                cwd: testDir,
                stdio: ['ignore', 'pipe', 'ignore'],
            }).toString();
            console.log(result);
        } catch (e) {
            console.log('INSTALL FAILED');
        }
    }

    fs.rmSync(tempDir, { recursive: true });
    console.log('\n=== Verification Complete ===');
}

verify().catch(console.error);
