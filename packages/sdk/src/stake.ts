import { ethers } from 'ethers';
import { ERC20_ABI, STAKING_ABI } from './abis';

export interface DepositStakeResult {
  txHash: string;
  approveTxHash?: string;
}

// Operator deposits bond for an agent. Handles the ERC-20 approval that
// SigvaraStaking.depositStake requires: reads the bond token from the staking
// contract, checks the current allowance, approves the exact shortfall only
// when needed, then deposits.
//
// `amount` is in the token's smallest unit (wei for the 18-decimal SVR token).
export async function depositStake(
  signer: ethers.Signer,
  didHash: string,
  amount: bigint,
  stakingAddress: string
): Promise<DepositStakeResult> {
  if (amount <= 0n) throw new Error('Stake amount must be positive');

  const staking = new ethers.Contract(stakingAddress, STAKING_ABI, signer);
  const tokenAddress: string = await staking.svrToken();
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const owner = await signer.getAddress();

  let approveTxHash: string | undefined;
  const allowance: bigint = await token.allowance(owner, stakingAddress);
  if (allowance < amount) {
    const approveTx = await token.approve(stakingAddress, amount);
    const approveReceipt = await approveTx.wait();
    approveTxHash = approveReceipt.hash;
  }

  const tx = await staking.depositStake(didHash, amount);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, approveTxHash };
}
