# Smoke-check Arc RPC connectivity (Foundry cast) and the deployer's USDC gas balance.
# Usage: pwsh scripts/check-arc.ps1 [-Deployer 0x...]
param([string]$Deployer = "")

$ErrorActionPreference = "Stop"

$endpoints = @(
    @{ Name = "arc_testnet"; Url = "https://rpc.testnet.arc.io"; Expect = 5042002 },
    @{ Name = "arc_mainnet"; Url = "https://rpc.mainnet.arc.io"; Expect = 5042 }
)

foreach ($ep in $endpoints) {
    Write-Host "== $($ep.Name) ==" -ForegroundColor Cyan
    $id = [int](cast chain-id --rpc-url $ep.Url).Trim()
    $block = (cast block-number --rpc-url $ep.Url).Trim()
    if ($id -ne $ep.Expect) {
        throw "Unexpected chain id for $($ep.Name): got $id, expected $($ep.Expect)"
    }
    $gas = (cast gas-price --rpc-url $ep.Url).Trim()
    Write-Host "  chainId=$id  block=$block  gasPrice=$gas wei (USDC, 18 dec)  OK"
    if ($Deployer) {
        # Native balance is USDC with 18 decimals at the EVM level.
        $bal = (cast balance $Deployer --rpc-url $ep.Url --ether).Trim()
        Write-Host "  deployer $Deployer balance: $bal USDC"
    }
}

Write-Host ""
Write-Host "Named Foundry aliases (foundry.toml):" -ForegroundColor Cyan
cast chain-id --rpc-url arc_testnet
cast chain-id --rpc-url arc_mainnet

Write-Host ""
Write-Host "Ready. Next: fund the deployer with testnet USDC (https://faucet.circle.com), then:" -ForegroundColor Green
Write-Host '  $env:DEPLOYER_PRIVATE_KEY="0x..."'
Write-Host "  forge script script/Deploy.s.sol --rpc-url arc_testnet -vvvv            # simulate"
Write-Host "  forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast -vvvv  # deploy"
Write-Host "See docs/arc.md"
