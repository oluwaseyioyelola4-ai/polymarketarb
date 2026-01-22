import { ethers } from 'ethers';
import { AssetType } from '@polymarket/clob-client';

/**
 * Wallet Manager for Real Trading on Polymarket
 * 
 * This module provides comprehensive wallet and USDC management functions
 * for live trading with real funds on Polymarket.
 * 
 * Key Features:
 * - USDC balance and allowance checking
 * - USDC approval for Polymarket exchange
 * - Deposit USDC to exchange
 * - Withdraw USDC from exchange
 * - Position tracking and management
 * - Safety checks and error handling
 */

// USDC contract addresses
const USDC_ADDRESS_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDCe (bridged) on Polygon
const USDC_ADDRESS_POLYGON_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC on Polygon

// Polymarket CTF Exchange address (for approvals)
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

// Standard ERC20 ABI for USDC interactions
const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)'
];

/**
 * Create a wallet manager instance
 * @param {Object} config - Configuration
 * @param {ethers.Wallet} config.wallet - Ethers wallet instance
 * @param {ethers.Provider} config.provider - Ethers provider instance
 * @param {ClobClient} config.clobClient - Polymarket CLOB client
 * @param {Function} config.log - Logging function
 * @returns {Object} Wallet manager with all functions
 */
export function createWalletManager({ wallet, provider, clobClient, log, funderAddress = null, signatureType = 0 }) {
    if (!wallet || !provider || !clobClient || !log) {
        throw new Error('Wallet manager requires wallet, provider, clobClient, and log function');
    }

    const signerAddress = wallet.address;
    const funder = funderAddress || signerAddress;
    const isFunderSameAsSigner = String(funder).toLowerCase() === String(signerAddress).toLowerCase();
    
    // Use the bridged USDC by default (most common)
    const usdcReadContract = new ethers.Contract(USDC_ADDRESS_POLYGON, ERC20_ABI, provider);
    const usdcWriteContract = new ethers.Contract(USDC_ADDRESS_POLYGON, ERC20_ABI, wallet);
    const usdcReadContractNative = new ethers.Contract(USDC_ADDRESS_POLYGON_NATIVE, ERC20_ABI, provider);

    async function getUSDCBalanceForAddress(address, contract = usdcReadContract) {
        const [balance, decimals] = await Promise.all([
            contract.balanceOf(address),
            contract.decimals()
        ]);

        const balanceFormatted = Number(ethers.utils.formatUnits(balance, decimals));
        return {
            balance: balanceFormatted,
            decimals: Number(decimals),
            raw: balance
        };
    }

    /**
     * Get USDC balance in wallet (on-chain)
     * @returns {Promise<{balance: number, decimals: number}>}
     */
    async function getWalletUSDCBalance() {
        try {
            const res = await getUSDCBalanceForAddress(funder, usdcReadContract);
            log(`Wallet USDC balance (${funder}): $${res.balance.toFixed(2)}`, 'INFO');
            return res;
        } catch (err) {
            log(`Failed to get wallet USDC balance: ${err.message}`, 'ERROR');
            throw err;
        }
    }

    async function getSignerUSDCBalance() {
        if (isFunderSameAsSigner) return null;
        try {
            const res = await getUSDCBalanceForAddress(signerAddress, usdcReadContract);
            log(`Signer USDC balance (${signerAddress}): $${res.balance.toFixed(2)}`, 'INFO');
            return res;
        } catch (err) {
            log(`Failed to get signer USDC balance: ${err.message}`, 'ERROR');
            return null;
        }
    }

    async function getNativeUSDCBalance() {
        try {
            const res = await getUSDCBalanceForAddress(funder, usdcReadContractNative);
            return res;
        } catch {
            return null;
        }
    }

    /**
     * Get USDC allowance for Polymarket exchange
     * @returns {Promise<number>} Allowance amount in USDC
     */
    async function getUSDCAllowance() {
        try {
            const allowance = await usdcReadContract.allowance(funder, CTF_EXCHANGE_ADDRESS);
            const decimals = await usdcReadContract.decimals();
            const allowanceFormatted = Number(ethers.utils.formatUnits(allowance, decimals));
            
            log(`USDC allowance for exchange (${funder}): $${allowanceFormatted.toFixed(2)}`, 'INFO');
            return allowanceFormatted;
        } catch (err) {
            log(`Failed to get USDC allowance: ${err.message}`, 'ERROR');
            throw err;
        }
    }

    /**
     * Approve USDC spending for Polymarket exchange
     * @param {number} amount - Amount in USDC to approve (use -1 for max approval)
     * @returns {Promise<{success: boolean, txHash: string}>}
     */
    async function approveUSDC(amount = -1) {
        try {
            const decimals = await usdcReadContract.decimals();
            
            // Use max uint256 for unlimited approval if amount is -1
            const approvalAmount = amount === -1 
                ? ethers.constants.MaxUint256 
                : ethers.utils.parseUnits(amount.toString(), decimals);
            
            log(`Approving ${amount === -1 ? 'unlimited' : '$' + amount} USDC for exchange...`, 'INFO');
            
            const tx = await usdcWriteContract.approve(CTF_EXCHANGE_ADDRESS, approvalAmount);
            log(`Approval transaction sent: ${tx.hash}`, 'INFO');
            log(`Waiting for confirmation...`, 'INFO');
            
            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                log(`✓ USDC approved successfully! Gas used: ${receipt.gasUsed.toString()}`, 'SUCCESS');
                return { success: true, txHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
            } else {
                throw new Error('Transaction failed');
            }
        } catch (err) {
            log(`USDC approval failed: ${err.message}`, 'ERROR');
            throw err;
        }
    }

    /**
     * Get exchange balance and allowance from CLOB API
     * @returns {Promise<{balance: number, allowance: number}>}
     */
    async function getExchangeBalance() {
        try {
            const res = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            const balance = Number.parseFloat(res?.balance || 0);
            const allowance = Number.parseFloat(res?.allowance || 0);
            
            log(`Exchange balance: $${balance.toFixed(2)} | Allowance: $${allowance.toFixed(2)}`, 'INFO');
            
            return { balance, allowance };
        } catch (err) {
            log(`Failed to get exchange balance: ${err.message}`, 'ERROR');
            throw err;
        }
    }

    /**
     * Deposit USDC to Polymarket exchange
     * @param {number} amount - Amount in USDC to deposit
     * @returns {Promise<{success: boolean, txHash: string}>}
     */
    async function depositUSDC(amount) {
        try {
            if (!(amount > 0)) {
                throw new Error('Deposit amount must be positive');
            }

            // Check wallet balance
            const { balance: walletBalance, decimals } = await getWalletUSDCBalance();
            if (walletBalance < amount) {
                throw new Error(`Insufficient wallet balance: $${walletBalance.toFixed(2)} < $${amount.toFixed(2)}`);
            }

            // Check allowance
            const allowance = await getUSDCAllowance();
            if (allowance < amount) {
                log(`Insufficient allowance ($${allowance.toFixed(2)} < $${amount.toFixed(2)}), approving...`, 'WARN');
                await approveUSDC(amount * 2); // Approve 2x to avoid frequent approvals
            }

            log(`Depositing $${amount.toFixed(2)} USDC to exchange...`, 'INFO');
            
            // Use CLOB client's deposit function
            const amountRaw = ethers.utils.parseUnits(amount.toString(), decimals);
            const tx = await clobClient.depositCollateral(amountRaw.toString());
            
            log(`Deposit transaction sent, waiting for confirmation...`, 'INFO');
            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                log(`✓ Deposited $${amount.toFixed(2)} USDC successfully!`, 'SUCCESS');
                return { success: true, txHash: receipt.hash, amount };
            } else {
                throw new Error('Deposit transaction failed');
            }
        } catch (err) {
            log(`Deposit failed: ${err.message}`, 'ERROR');
            throw err;
        }
    }

    /**
     * Withdraw USDC from Polymarket exchange
     * @param {number} amount - Amount in USDC to withdraw
     * @returns {Promise<{success: boolean, txHash: string}>}
     */
    async function withdrawUSDC(amount) {
        try {
            if (!(amount > 0)) {
                throw new Error('Withdrawal amount must be positive');
            }

            if (!isFunderSameAsSigner) {
                throw new Error(`Withdrawal must be executed by funder wallet ${funder}. This signer is ${signerAddress}.`);
            }

            // Check exchange balance
            const { balance: exchangeBalance } = await getExchangeBalance();
            if (exchangeBalance < amount) {
                throw new Error(`Insufficient exchange balance: $${exchangeBalance.toFixed(2)} < $${amount.toFixed(2)}`);
            }

            log(`Withdrawing $${amount.toFixed(2)} USDC from exchange...`, 'INFO');
            
            const decimals = 6; // USDC decimals
            const amountRaw = ethers.utils.parseUnits(amount.toString(), decimals);
            const tx = await clobClient.withdrawCollateral(amountRaw.toString());
            
            log(`Withdrawal transaction sent, waiting for confirmation...`, 'INFO');
            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                log(`✓ Withdrew $${amount.toFixed(2)} USDC successfully!`, 'SUCCESS');
                return { success: true, txHash: receipt.hash, amount };
            } else {
                throw new Error('Withdrawal transaction failed');
            }
        } catch (err) {
            log(`Withdrawal failed: ${err.message}`, 'ERROR');
            throw err;
        }
    }

    /**
     * Check if sufficient funds are available for trading
     * @param {number} requiredAmount - Required USDC amount
     * @returns {Promise<{ok: boolean, balance: number, allowance: number, message: string}>}
     */
    async function checkTradingReadiness(requiredAmount) {
        try {
            const { balance, allowance } = await getExchangeBalance();
            
            if (balance < requiredAmount) {
                return {
                    ok: false,
                    balance,
                    allowance,
                    message: `Insufficient balance: $${balance.toFixed(2)} < $${requiredAmount.toFixed(2)}`
                };
            }
            
            if (allowance < requiredAmount) {
                return {
                    ok: false,
                    balance,
                    allowance,
                    message: `Insufficient allowance: $${allowance.toFixed(2)} < $${requiredAmount.toFixed(2)}`
                };
            }
            
            return {
                ok: true,
                balance,
                allowance,
                message: 'Ready to trade'
            };
        } catch (err) {
            return {
                ok: false,
                balance: 0,
                allowance: 0,
                message: `Error checking readiness: ${err.message}`
            };
        }
    }

    /**
     * Get comprehensive wallet status
     * @returns {Promise<Object>} Complete wallet status
     */
    async function getWalletStatus() {
        try {
            const [
                walletUSDC,
                exchangeData,
                allowance,
                signerUSDC,
                nativeUSDC
            ] = await Promise.all([
                getWalletUSDCBalance(),
                getExchangeBalance(),
                getUSDCAllowance(),
                getSignerUSDCBalance(),
                getNativeUSDCBalance()
            ]);

            return {
                address: signerAddress,
                funderAddress: funder,
                wallet: {
                    usdcBalance: walletUSDC.balance,
                    decimals: walletUSDC.decimals,
                    signerUsdcBalance: signerUSDC?.balance ?? null,
                    nativeUsdcBalance: nativeUSDC?.balance ?? null
                },
                exchange: {
                    balance: exchangeData.balance,
                    allowance: exchangeData.allowance
                },
                approval: {
                    current: allowance,
                    spender: CTF_EXCHANGE_ADDRESS
                },
                totalAvailable: exchangeData.balance
            };
        } catch (err) {
            log(`Failed to get wallet status: ${err.message}`, 'ERROR');
            throw err;
        }
    }

    /**
     * Setup wallet for trading (approve + deposit if needed)
     * @param {Object} options - Setup options
     * @param {number} options.depositAmount - Amount to deposit (optional)
     * @param {boolean} options.ensureApproval - Ensure unlimited approval (default: true)
     * @returns {Promise<Object>} Setup result
     */
    async function setupWalletForTrading({ depositAmount = null, ensureApproval = true } = {}) {
        try {
            log('Setting up wallet for trading...', 'INFO');
            
            const status = await getWalletStatus();
            log(`Current status: Wallet: $${status.wallet.usdcBalance.toFixed(2)} | Exchange: $${status.exchange.balance.toFixed(2)}`, 'INFO');
            
            // Check and set approval if needed
            if (ensureApproval) {
                const currentAllowance = status.approval.current;
                if (currentAllowance < 1000) { // Less than $1000 allowance
                    log('Setting up unlimited USDC approval...', 'INFO');
                    await approveUSDC(-1);
                } else {
                    log(`Approval already set: $${currentAllowance.toFixed(2)}`, 'INFO');
                }
            }
            
            // Deposit if requested
            if (depositAmount && depositAmount > 0) {
                log(`Depositing $${depositAmount.toFixed(2)} USDC...`, 'INFO');
                await depositUSDC(depositAmount);
            }
            
            // Get final status
            const finalStatus = await getWalletStatus();
            log('✓ Wallet setup complete!', 'SUCCESS');
            log(`Final status: Exchange balance: $${finalStatus.exchange.balance.toFixed(2)}`, 'INFO');
            
            return {
                success: true,
                status: finalStatus
            };
        } catch (err) {
            log(`Wallet setup failed: ${err.message}`, 'ERROR');
            throw err;
        }
    }

    // Return public API
    return {
        // Balance functions
        getWalletUSDCBalance,
        getExchangeBalance,
        getUSDCAllowance,
        getWalletStatus,
        
        // Approval functions
        approveUSDC,
        
        // Deposit/Withdraw functions
        depositUSDC,
        withdrawUSDC,
        
        // Trading readiness
        checkTradingReadiness,
        setupWalletForTrading,
        
        // Constants
        USDC_ADDRESS: USDC_ADDRESS_POLYGON,
        CTF_EXCHANGE_ADDRESS,
        walletAddress: signerAddress,
        funderAddress: funder,
        signatureType
    };
}

/**
 * Example usage:
 * 
 * const walletManager = createWalletManager({ wallet, provider, clobClient, log });
 * 
 * // Setup wallet for trading
 * await walletManager.setupWalletForTrading({ depositAmount: 100 });
 * 
 * // Check if ready to trade
 * const readiness = await walletManager.checkTradingReadiness(50);
 * if (readiness.ok) {
 *     // Place orders...
 * }
 * 
 * // Withdraw profits
 * await walletManager.withdrawUSDC(25);
 */
