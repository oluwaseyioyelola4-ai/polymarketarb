#!/usr/bin/env node

/**
 * Polymarket Arbitrage Bot Mode Launcher
 * Choose between different trading modes
 */

import { execSync } from 'child_process';
import readline from 'readline';
import { readdirSync } from 'fs';
import { join } from 'path';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            resolve(answer.trim());
        });
    });
}

async function main() {
    console.log('🚀 Polymarket Arbitrage Bot Mode Launcher\n');
    console.log('Available modes:\n');

    const modesDir = join(process.cwd(), 'modes');
    const modeFiles = readdirSync(modesDir).filter(file => file.endsWith('.js'));

    modeFiles.forEach((file, index) => {
        const modeName = file.replace('.js', '');
        console.log(`${index + 1}. ${modeName.charAt(0).toUpperCase() + modeName.slice(1)} Mode`);
    });

    console.log(`${modeFiles.length + 1}. Exit\n`);

    const choice = await question(`Choose a mode (1-${modeFiles.length + 1}): `);

    const choiceNum = parseInt(choice);
    if (choiceNum >= 1 && choiceNum <= modeFiles.length) {
        const selectedMode = modeFiles[choiceNum - 1].replace('.js', '');
        console.log(`\n⚡ Starting ${selectedMode} mode...\n`);
        execSync(`node engine.js ${selectedMode}`, { stdio: 'inherit' });
    } else if (choiceNum === modeFiles.length + 1) {
        console.log('Goodbye! 👋');
        rl.close();
        process.exit(0);
    } else {
        console.log('Invalid choice. Please try again.\n');
        return main();
    }

    rl.close();
}

main().catch(console.error);