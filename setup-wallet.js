#!/usr/bin/env node

/**
 * Wallet Setup Script for Live Trading
 * 
 * This script helps you set up your wallet for live trading on Polymarket:
 * 1. Check wallet USDC balance
 * 2. Approve USDC spending for Polymarket exchange
 * 3. Deposit USDC to exchange
 * 4. Check current status
 * 
 * Usage:
 *   node setup-wallet.js status              - Check current wallet status
 *   node setup-wallet.js approve [amount]    - Approve USDC (use 'max' for unlimited)
 *   node setup-wallet.js deposit <amount>    - Deposit USDC to exchange
 *   node setup-wallet.js withdraw <amount>   - Withdraw USDC from exchange
 *   node setup-wallet.js setup <amount>      - Complete setup (approve + deposit)
 *   node setup-wallet.js derive-keys         - Derive CLOB API keys from signer and update .env
 */

import { ethers } from 'ethers';
import { ClobClient, AssetType } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { createWalletManager } from './wallet-manager.js';

dotenv.config();

// Helper function to detect Gnosis Safe
const isGnosisSafe = async (address, provider) => {
    try {
        const code = await provider.getCode(address);
        return code !== '0x';
    } catch (error) {
        console.error(`Error checking wallet type: ${error}`);
        return false;
    }
};

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function colorize(text, color) {
    return `${colors[color] || ''}${text}${colors.reset}`;
}

function log(message, type = 'INFO') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = type === 'ERROR' ? colorize('✗', 'red')
        : type === 'SUCCESS' ? colorize('✓', 'green')
        : type === 'WARN' ? colorize('⚠', 'yellow')
        : colorize('•', 'blue');
    console.log(`${prefix} [${timestamp}] ${message}`);
}

async function main() {
    const command = process.argv[2];
    const arg = process.argv[3];

    // Validate environment
    if (!process.env.PRIVATE_KEY) {
        log('ERROR: PRIVATE_KEY not found in .env file', 'ERROR');
        log('Please add your wallet private key to the .env file:', 'INFO');
        log('PRIVATE_KEY=0x...', 'INFO');
        process.exit(1);
    }

    const CLOB_API_KEY = process.env.CLOB_API_KEY || process.env.POLY_API_KEY;
    const CLOB_API_SECRET = process.env.CLOB_API_SECRET || process.env.POLY_API_SECRET;
    const CLOB_API_PASSPHRASE = process.env.CLOB_API_PASSPHRASE || process.env.POLY_API_PASSPHRASE;

    if (command !== 'derive-keys' && command !== 'status' && command !== 'approve' && command !== 'deposit' && command !== 'setup' && (!CLOB_API_KEY || !CLOB_API_SECRET || !CLOB_API_PASSPHRASE)) {
        log('ERROR: CLOB API credentials not found', 'ERROR');
        log('Please add to .env file:', 'INFO');
        log('CLOB_API_KEY=your_key', 'INFO');
        log('CLOB_API_SECRET=your_secret', 'INFO');
        log('CLOB_API_PASSPHRASE=your_passphrase', 'INFO');
        process.exit(1);
    }

    // Setup provider and wallet
    const RPC_URL = process.env.RPC_URL || 'https://polygon-rpc.com';
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    log(`Using wallet: ${wallet.address}`, 'INFO');
    log(`Connected to: ${RPC_URL}`, 'INFO');
    
    // Certainty mode (proxy wallet) configuration
    const CERTAINTY_MODE = String(process.env.CERTAINTY_MODE || '').toLowerCase() === 'true';
    const PROXY_WALLET_ADDRESS = process.env.PROXY_WALLET_ADDRESS || null;
    const isProxySafe = CERTAINTY_MODE && PROXY_WALLET_ADDRESS ? await isGnosisSafe(PROXY_WALLET_ADDRESS, provider) : false;
    const signatureType = isProxySafe ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
    const funderAddress = CERTAINTY_MODE && PROXY_WALLET_ADDRESS ? PROXY_WALLET_ADDRESS : undefined;
    
    if (CERTAINTY_MODE) {
        if (!PROXY_WALLET_ADDRESS) {
            log('ERROR: CERTAINTY_MODE=true requires PROXY_WALLET_ADDRESS in .env', 'ERROR');
            process.exit(1);
        }
        log(`Certainty mode enabled with proxy wallet: ${PROXY_WALLET_ADDRESS}`, 'INFO');
    }
    console.log('');

    // Setup CLOB client
    let clobClient;
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};
    try {
        clobClient = new ClobClient(
            'https://clob.polymarket.com',
            137,
            wallet,
            undefined,
            signatureType,
            funderAddress
        );
        let creds = await clobClient.createApiKey();
        if (!creds || !creds.key) {
            creds = await clobClient.deriveApiKey();
        }
        clobClient = new ClobClient(
            'https://clob.polymarket.com',
            137,
            wallet,
            creds,
            signatureType,
            funderAddress
        );
    } catch (error) {
        log(`Failed to create API keys: ${error.message}`, 'ERROR');
        process.exit(1);
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
    }

    // Create wallet manager
    const walletManager = createWalletManager({
        wallet,
        provider,
        clobClient,
        log,
        funderAddress,
        signatureType
    });

    // Execute command
    try {
        switch (command) {
            case 'status': {
                await handleStatus(walletManager);
                break;
            }

            case 'approve': {
                const amount = arg === 'max' || arg === 'unlimited' ? -1 : parseFloat(arg);
                await handleApprove(walletManager, amount);
                break;
            }

            case 'deposit': {
                if (!arg || isNaN(parseFloat(arg))) {
                    log('ERROR: Please specify deposit amount', 'ERROR');
                    log('Usage: node setup-wallet.js deposit <amount>', 'INFO');
                    process.exit(1);
                }
                await handleDeposit(walletManager, parseFloat(arg));
                break;
            }

            case 'withdraw': {
                if (!arg || isNaN(parseFloat(arg))) {
                    log('ERROR: Please specify withdrawal amount', 'ERROR');
                    log('Usage: node setup-wallet.js withdraw <amount>', 'INFO');
                    process.exit(1);
                }
                await handleWithdraw(walletManager, parseFloat(arg));
                break;
            }

            case 'setup': {
                if (!arg || isNaN(parseFloat(arg))) {
                    log('ERROR: Please specify setup amount', 'ERROR');
                    log('Usage: node setup-wallet.js setup <amount>', 'INFO');
                    process.exit(1);
                }
                await handleSetup(walletManager, parseFloat(arg));
                break;
            }

            case 'derive-keys': {
                await handleDeriveKeys(clobClient, log);
                break;
            }

            default: {
                printUsage();
                break;
            }
        }
    } catch (err) {
        log(`Operation failed: ${err.message}`, 'ERROR');
        console.error(err);
        process.exit(1);
    }
}

async function handleStatus(walletManager) {
    log('Fetching wallet status...', 'INFO');
    console.log('');

    const status = await walletManager.getWalletStatus();

    console.log(colorize('═'.repeat(60), 'cyan'));
    console.log(colorize('  WALLET STATUS', 'bright'));
    console.log(colorize('═'.repeat(60), 'cyan'));
    console.log('');
    
    console.log(colorize('Signer Wallet Address:', 'yellow'));
    console.log(`  ${status.address}`);
    if (status.funderAddress && status.funderAddress.toLowerCase() !== status.address.toLowerCase()) {
        console.log('');
        console.log(colorize('Proxy (Funder) Wallet Address:', 'yellow'));
        console.log(`  ${status.funderAddress}`);
    }
    console.log('');
    
    console.log(colorize('On-Chain Wallet:', 'yellow'));
    console.log(`  Funder USDC Balance: ${colorize('$' + status.wallet.usdcBalance.toFixed(2), 'green')}`);
    if (status.wallet.nativeUsdcBalance !== null && Number.isFinite(status.wallet.nativeUsdcBalance)) {
        console.log(`  Funder Native USDC Balance: ${colorize('$' + status.wallet.nativeUsdcBalance.toFixed(2), 'green')}`);
    }
    if (status.wallet.signerUsdcBalance !== null && Number.isFinite(status.wallet.signerUsdcBalance)) {
        console.log(`  Signer USDC Balance: ${colorize('$' + status.wallet.signerUsdcBalance.toFixed(2), 'green')}`);
    }
    console.log('');
    
    console.log(colorize('Polymarket Exchange:', 'yellow'));
    console.log(`  Available Balance: ${colorize('$' + status.exchange.balance.toFixed(2), status.exchange.balance > 0 ? 'green' : 'red')}`);
    console.log(`  Allowance: ${colorize('$' + status.exchange.allowance.toFixed(2), status.exchange.allowance > 0 ? 'green' : 'red')}`);
    console.log('');
    
    console.log(colorize('USDC Approval:', 'yellow'));
    console.log(`  Current Allowance: ${colorize('$' + status.approval.current.toFixed(2), status.approval.current > 100 ? 'green' : 'yellow')}`);
    console.log(`  Exchange Contract: ${status.approval.spender}`);
    console.log('');
    
    console.log(colorize('Trading Status:', 'yellow'));
    const canTrade = status.exchange.balance > 10 && status.exchange.allowance > 10;
    console.log(`  Ready to Trade: ${canTrade ? colorize('YES ✓', 'green') : colorize('NO ✗', 'red')}`);
    if (!canTrade) {
        console.log('');
        console.log(colorize('  To start trading:', 'yellow'));
        if (status.exchange.balance < 10) {
            console.log(`    1. Deposit USDC: ${colorize('node setup-wallet.js deposit 100', 'cyan')}`);
        }
        if (status.approval.current < 100) {
            console.log(`    2. Approve USDC: ${colorize('node setup-wallet.js approve max', 'cyan')}`);
        }
        console.log(`  Or use quick setup: ${colorize('node setup-wallet.js setup 100', 'cyan')}`);
    }
    console.log('');
    console.log(colorize('═'.repeat(60), 'cyan'));
}

async function handleApprove(walletManager, amount) {
    if (amount === -1) {
        log('Approving unlimited USDC spending...', 'INFO');
    } else if (isNaN(amount) || amount <= 0) {
        log('ERROR: Invalid amount. Use a positive number or "max" for unlimited', 'ERROR');
        process.exit(1);
    } else {
        log(`Approving $${amount.toFixed(2)} USDC spending...`, 'INFO');
    }
    
    const result = await walletManager.approveUSDC(amount);
    
    console.log('');
    log('Approval successful!', 'SUCCESS');
    log(`Transaction: ${result.txHash}`, 'INFO');
    log(`Gas used: ${result.gasUsed}`, 'INFO');
}

async function handleDeposit(walletManager, amount) {
    log(`Depositing $${amount.toFixed(2)} USDC to exchange...`, 'INFO');
    
    const result = await walletManager.depositUSDC(amount);
    
    console.log('');
    log('Deposit successful!', 'SUCCESS');
    log(`Amount: $${result.amount.toFixed(2)}`, 'INFO');
    log(`Transaction: ${result.txHash}`, 'INFO');
    
    console.log('');
    await handleStatus(walletManager);
}

async function handleWithdraw(walletManager, amount) {
    log(`Withdrawing $${amount.toFixed(2)} USDC from exchange...`, 'INFO');
    
    const result = await walletManager.withdrawUSDC(amount);
    
    console.log('');
    log('Withdrawal successful!', 'SUCCESS');
    log(`Amount: $${result.amount.toFixed(2)}`, 'INFO');
    log(`Transaction: ${result.txHash}`, 'INFO');
    
    console.log('');
    await handleStatus(walletManager);
}

async function handleSetup(walletManager, amount) {
    log(`Setting up wallet for trading with $${amount.toFixed(2)}...`, 'INFO');
    console.log('');
    
    const result = await walletManager.setupWalletForTrading({
        depositAmount: amount,
        ensureApproval: true
    });
    
    console.log('');
    log('Setup complete!', 'SUCCESS');
    console.log('');
    
    await handleStatus(walletManager);
    
    console.log('');
    log('Your wallet is now ready for live trading!', 'SUCCESS');
    log('To start trading, set LIVE_TRADING=true and ENABLE_LIVE_ORDERS=true in .env', 'INFO');
}

async function handleDeriveKeys(clobClient, logFn) {
    logFn('Deriving CLOB API keys from signer...', 'INFO');
    let creds;
    try {
        creds = await clobClient.createOrDeriveApiKey();
    } catch (err) {
        logFn(`Create API key failed (${err?.message || err}); attempting derive...`, 'WARN');
        creds = await clobClient.deriveApiKey();
    }

    if (!creds?.apiKey || !creds?.secret || !creds?.passphrase) {
        logFn('Create/derive returned empty creds; attempting derive-api-key endpoint...', 'WARN');
        creds = await clobClient.deriveApiKey();
    }

    if (!creds?.apiKey || !creds?.secret || !creds?.passphrase) {
        throw new Error('Failed to derive API credentials');
    }

    const envPath = path.join(process.cwd(), '.env');
    let content = '';
    try {
        content = await fs.readFile(envPath, 'utf8');
    } catch {
        content = '';
    }

    const upsert = (text, key, value) => {
        const line = `${key}=${value}`;
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(text)) return text.replace(regex, line);
        return (text.endsWith('\n') || text.length === 0) ? `${text}${line}\n` : `${text}\n${line}\n`;
    };

    let updated = content;
    updated = upsert(updated, 'CLOB_API_KEY', creds.apiKey);
    updated = upsert(updated, 'CLOB_API_SECRET', creds.secret);
    updated = upsert(updated, 'CLOB_API_PASSPHRASE', creds.passphrase);

    await fs.writeFile(envPath, updated, 'utf8');
    logFn('CLOB API keys updated in .env (values not printed for safety).', 'SUCCESS');
}

function printUsage() {
    console.log('');
    console.log(colorize('Polymarket Wallet Setup Tool', 'bright'));
    console.log('');
    console.log(colorize('Usage:', 'yellow'));
    console.log(`  ${colorize('node setup-wallet.js <command> [args]', 'cyan')}`);
    console.log('');
    console.log(colorize('Commands:', 'yellow'));
    console.log(`  ${colorize('status', 'green')}              Check current wallet status`);
    console.log(`  ${colorize('approve <amount>', 'green')}    Approve USDC spending (use "max" for unlimited)`);
    console.log(`  ${colorize('deposit <amount>', 'green')}    Deposit USDC to Polymarket exchange`);
    console.log(`  ${colorize('withdraw <amount>', 'green')}   Withdraw USDC from exchange`);
    console.log(`  ${colorize('setup <amount>', 'green')}      Complete setup (approve + deposit)`);
    console.log(`  ${colorize('derive-keys', 'green')}          Derive CLOB API keys and update .env`);
    console.log('');
    console.log(colorize('Examples:', 'yellow'));
    console.log(`  ${colorize('node setup-wallet.js status', 'cyan')}`);
    console.log(`  ${colorize('node setup-wallet.js approve max', 'cyan')}`);
    console.log(`  ${colorize('node setup-wallet.js deposit 100', 'cyan')}`);
    console.log(`  ${colorize('node setup-wallet.js setup 100', 'cyan')}  ${colorize('(recommended)', 'green')}`);
    console.log(`  ${colorize('node setup-wallet.js derive-keys', 'cyan')}`);
    console.log('');
}

// Run the script
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
